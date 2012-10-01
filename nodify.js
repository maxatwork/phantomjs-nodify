if (typeof nodify !== 'string') {
  console.error("Global variable `nodify` not set or not a string!");
  phantom.exit(1);
}

var global = window;

(function() {
  // common stuff
  
  var fs = require('fs');
  var system = require('system');
  
  function dirname(path) {
    if (path.match(/^[A-Z]\:\/?$/)) return '';
    var chunks = path.replace('\\', '/').split('/');
    var result = chunks.splice(0, chunks.length - 1).join('/');
    return result;
  };
  
  function basename(path) {
    return path.replace(/.*\//, '');
  };
  
  function joinPath() {
    var args = Array.prototype.slice.call(arguments);
    return args.join(fs.separator);
  };
  
  var rootPath = fs.absolute(phantom.libraryPath);
  var nodifyPath = dirname(nodify);
  nodifyPath = fs.absolute(joinPath(rootPath, nodifyPath));
  var mainScript;

  if (phantom.version.major >= 1 && phantom.version.minor >= 5) {  
    if (system.args[0].match(/^[A-Z]\:/)) {
      mainScript = basename(system.args[0]);
    } else {
      mainScript = joinPath(rootPath, basename(system.args[0]));
    }
    mainScript = fs.absolute(mainScript);
  } else {
    var mainScript = fs.absolute(joinPath(rootPath, phantom.scriptName));
  }
  var sourceIds = {};
  nodify = {};

  function getErrorMessage(e, withMessage) {
    withMessage = typeof withMessage === 'undefined' ? true : withMessage;
    return (e.fileName || sourceIds[e.sourceId]) + ':' + e.line +
      (withMessage ? ' ' + e : '');
  };

  // patches
  
  // TODO: remove when PhantomJS has full module support
  function patchRequire() {
    var phantomRequire = nodify.__orig__require = require;
    var cache = {};
    var phantomModules = ['fs', 'webpage', 'webserver', 'system'];

    var extensions = {
      '.js': function(module, filename) {
        var code = fs.read(filename);
        module._compile(code);
      },

      '.coffee': function(module, filename) {
        var code = fs.read(filename);
        var CoffeeScript = require('_coffee-script');
        try {
          code = CoffeeScript.compile(code);
        } catch (e) {
          e.fileName = filename;
          throw e;
        }
        module._compile(code);
      },

      '.json': function(module, filename) {
        module.exports = JSON.parse(fs.read(filename));
      }
    };

    function tryFile(path) {
      if (fs.isFile(path)) return path;
      return null;
    }

    function tryExtensions(path) {
      var filename;
      var exts = Object.keys(extensions);
      for (var i=0; i<exts.length; ++i) {
        filename = tryFile(path + exts[i]);
        if (filename) return filename;
      }
      return null;
    }

    function tryPackage(path) {
      var filename, package, packageFile = joinPath(path, 'package.json');
      if (fs.isFile(packageFile)) {
        package = JSON.parse(fs.read(packageFile));
        if (!package || !package.main) return null;
        
        filename = fs.absolute(joinPath(path, package.main));

        return tryFile(filename) || tryExtensions(filename) ||
          tryExtensions(joinPath(filename, 'index'));
      }
      return null;
    }

    function Module(filename, stubs) {
      this.id = this.filename = fs.absolute(filename);
      this.dirname = dirname(filename);
      this.exports = {};
      this.stubs = {};
      for (var name in stubs) {
        this.stubs[name] = stubs[name];
      }
    }

    Module.prototype._getPaths = function(request) {
      var paths = [], dir;
      if (request[0] === '.') {
        paths.push(fs.absolute(joinPath(this.dirname, request)));
      } else if (request[0] === '/' || request.match(/^[A-Z]:/)) {
        paths.push(fs.absolute(request));
      } else {
        dir = this.dirname;
        while (dir !== '') {
          paths.push(joinPath(dir, 'node_modules', request));
          dir = dirname(dir);
        }
        paths.push(joinPath(nodifyPath, 'modules', request));
      }

      return paths;
    };

    Module.prototype._getFilename = function(request) {
      var path, filename = null, paths = this._getPaths(request);
      for (var i=0; i<paths.length && !filename; ++i) {
        path = paths[i];
        filename = tryFile(path) || tryExtensions(path) || tryPackage(path) ||
          tryExtensions(joinPath(path, 'index'));
      }

      return filename;
    };

    Module.prototype._getRequire = function() {
      var self = this;
      
      function require(request) {
        return self.require(request);
      }
      require.cache = cache;
      require.stub = function(request, exports) {
        self.stubs[request] = { exports: exports };
      };

      return require;
    };

    Module.prototype._load = function() {
      var ext = this.filename.match(/\.[^.]+$/);
      if (!ext) ext = '.js';
      extensions[ext](this, this.filename);
    };

    Module.prototype._compile = function(code) {
      // a trick to associate Error's sourceId with file
      code += ";throw new Error('__sourceId__');";
      try {
        var fn = new Function('require', 'exports', 'module', code);
        fn(this._getRequire(), this.exports, this);
      } catch (e) {
        // assign source id (check if already assigned to avoid reassigning
        // on exceptions propagated from other files)
        if (!sourceIds.hasOwnProperty(e.sourceId)) {
          sourceIds[e.sourceId] = this.filename;
        }
        // if it's not the error we added, propagate it
        if (e.message !== '__sourceId__') {
          throw e;
        }
      }
    };

    Module.prototype.require = function(request) {
      if (phantomModules.indexOf(request) !== -1) {
        return phantomRequire(request);
      }

      if (this.stubs.hasOwnProperty(request)) {
        return this.stubs[request].exports;
      }

      var filename = this._getFilename(request);
      if (!filename) {
        var e = new Error("Cannot find module '" + request + "'");
        e.fileName = this.filename;
        e.line = '';
        throw e;
      }

      if (cache.hasOwnProperty(filename)) {
        return cache[filename].exports;
      }

      var module = new Module(filename, this.stubs);
      cache[filename] = module;
      module._load();

      return module.exports;
    };

    global.require = new Module(mainScript)._getRequire();
  };
  
  // process
  function addProcess() {
    var EventEmitter = require('events').EventEmitter;
    var process = global.process = new EventEmitter;
    process.env = {};
    process.nextTick = function(fn) { fn() };
    process.exit = function(status) {
      process.emit('exit');
      phantom.exit(status);
    };
    process.stdout = {
      write: function(string) { fs.write("/dev/stdout", string, "w"); }
    };
    process.stderr = {
      write: function(string) { fs.write("/dev/stderr", string, "w"); }
    };
    if (phantom.version.major >= 1 && phantom.version.minor >= 5) {
      process.argv = ['nodify'].concat(require('system').args);
    } else {
      process.argv = ['nodify', ''].concat(phantom.args);
    }
    process.argv[1] = mainScript;
    process.cwd = function() {
      return rootPath;
    };
    
    var phantomSetTimeout = nodify.__orig__setTimeout = setTimeout;
    setTimeout = function(fn, delay) {
      return phantomSetTimeout(function() {
        try {
          fn();
        } catch (e) {
          process.emit('uncaughtException', e);
        }
      }, delay);
    };
  };
  
  // make errors in event listeners propagate to uncaughtException
  function patchEvents() {
    var EventEmitter = require('events').EventEmitter;
    
    var eventEmitterEmit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function() {
      try {
        return eventEmitterEmit.apply(this, arguments);
      } catch (e) {
        process.emit('uncaughtException', e);
      }
    }
  }; 
  
  // better console
  function patchConsole() {
    var util = require('util');
    ['log', 'error', 'debug', 'warn', 'info'].forEach(function(fn) {
      var fn_ = '__orig__' + fn;
      console[fn_] = console[fn];
      console[fn] = function() {
        console[fn_](util.format.apply(this, arguments));
      };
    });
  };
  
  // dummy stack trace
  // TODO: remove when PhantomJS gets JS engine upgrade
  function addErrorStack() {
    Object.defineProperty(Error.prototype, 'stack', {
      set: function(string) { this._stack = string; },
      get: function() {
        if (this._stack) {
          return this._stack;
        } else if (this.fileName || this.sourceId) {
          return this.toString() + '\nat ' + getErrorMessage(this, false);
        }
        return this.toString() + '\nat unknown';
      },
      configurable: true,
      enumerable: true
    });
  };

  // Function.bind
  // TODO: remove when PhantomJS gets JS engine upgrade
  function addFunctionBind() {
    if (!Function.prototype.bind) {
      Function.prototype.bind = function (oThis) {
        if (typeof this !== "function") {
          // closest thing possible to the ECMAScript 5 internal IsCallable function
          throw new TypeError("Function.prototype.bind - what is trying to be bound is not callable"); 
        } 
        
        var aArgs = Array.prototype.slice.call(arguments, 1), 
          fToBind = this, 
          fNOP = function () {},
          fBound = function () {
            return fToBind.apply(this instanceof fNOP 
                                   ? this 
                                   : oThis || window, 
                                 aArgs.concat(Array.prototype.slice.call(arguments)));
          };
        
        fNOP.prototype = this.prototype;
        fBound.prototype = new fNOP();
        
        return fBound;
      };
    }
  };
  
  // dummy Buffer
  function addBuffer() {
    global.Buffer = {
      isBuffer: function() { return false; }
    };
  };

  // nodify
  
  patchRequire();
  addProcess();
  patchEvents();
  patchConsole();
  addErrorStack();
  addFunctionBind();
  addBuffer();
  
  nodify.run = function(fn) {
    try {
      fn();
    } catch(e) {
      console.error(getErrorMessage(e));
      process.exit(1);
    }
  };
  
}());

