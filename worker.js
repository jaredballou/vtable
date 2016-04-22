var Module = {};
importScripts('vtable.js');

function demangleSymbol(func) {
  try {
    if (typeof func !== 'string') {
      throw new Error('input not a string');
    }
    var buf = Module['_malloc'](func.length + 1);
    Module['writeStringToMemory'](func, buf);
    var status = Module['_malloc'](4);
    var ret = Module['___cxa_demangle'](buf, 0, 0, status);
    var intStatus = Module['getValue'](status, 'i32');
    switch (intStatus) {
      case 0:
        if (!ret) {
          throw new Error('___cxa_demangle returned NULL');
        }
        return Module['Pointer_stringify'](ret);
      case -1:
        throw new Error('a memory allocation failiure occurred');
      case -2:
        throw new Error('input is not a valid name under the C++ ABI mangling rules');
      case -3:
        throw new Error('one of the arguments is invalid');
      default:
        throw new Error('encountered an unknown error');
    }
  } catch(e) {
    console.error('Failed to demangle \'' + func + '\' (' + e.message + ')');
    return func;
  } finally {
    if (buf) Module['_free'](buf);
    if (status) Module['_free'](status);
    if (ret) Module['_free'](ret);
  }
}

function getRodata(programInfo, address, size) {
  if (programInfo.rodataStart.high !== 0 || address.high !== 0 || size.high !== 0) {
    throw '>= 32-bit rodata is not supported';
  }

  for (var i = 0; i < programInfo.rodataChunks.size(); ++i) {
    var chunk = programInfo.rodataChunks.get(i);

    if (chunk.offset.high !== 0) {
      throw '>= 32-bit rodata is not supported';
    }

    var start = address.low - (programInfo.rodataStart.low + chunk.offset.low);
    var end = start + size.low;

    if (start < 0 || end > chunk.data.length) {
      continue;
    }

    return chunk.data.subarray(start, end);
  }

  return null;
}

var loaded = 0;
var total = 0;
var lastProgressUpdate = 0;
function sendProgressUpdate(force) {
  var now = Date.now();
  if (!force && (now - lastProgressUpdate) < 50) {
    return;
  }

  self.postMessage({ loaded: loaded, total: total });
  lastProgressUpdate = now;
}

function hex32(n) {
  return (n === 0) ? '00000000' : ('0000000' + ((n|0)+4294967296).toString(16)).substr(-8);
}

function hex64(n) {
  return hex32(n.high) + hex32(n.low);
}

function key(n) {
  return hex64(n);
}

function isZero(n) {
  return n.low === 0 && n.high === 0;
}

self.onmessage = function(event) {
  var programInfo = Module.process(event.data);

  if (programInfo.error.length > 0) {
    // Don't bother doing any more work.
    self.postMessage({ error: programInfo.error });
    return;
  }

  console.info("address size: " + programInfo.addressSize);
  console.info("symbols: " + programInfo.symbols.size());

  var listOfVirtualClasses = [];
  var addressToSymbolMap = {};

  for (var i = 0; i < programInfo.symbols.size(); ++i) {
    var symbol = programInfo.symbols.get(i);

    if (isZero(symbol.address) || isZero(symbol.size) || symbol.name.length === 0) {
      continue;
    }

    if (symbol.name.substr(0, 4) === '_ZTV') {
      listOfVirtualClasses.push(symbol);
    }

    addressToSymbolMap[key(symbol.address)] = symbol;
  }

  console.info("virtual classes: " + listOfVirtualClasses.length);

  var pureVirtualFunction = {
    id: null,
    name: '(pure virtual function)',
    symbol: null,
    searchKey: null,
    isThunk: false,
    classes: [],
  };

  var out = {
    classes: [],
    functions: [],
  };

  var addressToFunctionMap = {};

  total += listOfVirtualClasses.length;
  for (var classIndex = 0; classIndex < listOfVirtualClasses.length; ++classIndex) {
    loaded += 1;

    var symbol = listOfVirtualClasses[classIndex];
    var name = demangleSymbol(symbol.name).substr(11);

    var data = getRodata(programInfo, symbol.address, symbol.size);
    if (!data) {
      //console.warn('VTable for ' + name + ' is outside .rodata');
      sendProgressUpdate(false);
      continue;
    }

    var classInfo = {
      id: key(symbol.address),
      name: name,
      searchKey: name.toLowerCase(),
      vtables: [],
      hasMissingFunctions: false,
    };

    var currentVtable;
    var dataView = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    total += dataView.length;
    for (var functionIndex = 0; functionIndex < dataView.length; ++functionIndex) {
      loaded += 1;

      var functionAddress = {
        high: 0,
        low: dataView[functionIndex],
        unsigned: true,
      };

      if (programInfo.addressSize > Uint32Array.BYTES_PER_ELEMENT) {
        functionAddress.high = dataView[++functionIndex];
        loaded += 1;
      }

      var functionSymbol = addressToSymbolMap[key(functionAddress)];

      // This could be the end of the vtable, or it could just be a pure/deleted func.
      if (!functionSymbol && (classInfo.vtables.length === 0 || !isZero(functionAddress))) {
        currentVtable = [];
        classInfo.vtables.push({
          offset: ~(functionAddress.low - 1),
          functions: currentVtable,
        });

        // Skip the RTTI pointer and thisptr adjuster,
        // We'll need to do more work here for virtual bases.
        var skip = programInfo.addressSize / Uint32Array.BYTES_PER_ELEMENT;
        functionIndex += skip;
        loaded += skip;

        sendProgressUpdate(false);
        continue;
      }

      var functionSymbol = functionSymbol && functionSymbol.name;
      if (!functionSymbol || functionSymbol === '__cxa_deleted_virtual' || functionSymbol === '__cxa_pure_virtual') {
        classInfo.hasMissingFunctions = true;
        currentVtable.push(pureVirtualFunction);

        sendProgressUpdate(false);
        continue;
      }

      var functionInfo = addressToFunctionMap[key(functionAddress)];
      if (!functionInfo) {
        var functionSignature = demangleSymbol(functionSymbol);

        var functionName = functionSignature;
        var startOfArgs = functionName.lastIndexOf('(');
        if (startOfArgs !== -1) {
          functionName = functionName.substr(0, startOfArgs);
        }

        var functionShortName = functionName;
        var startOfName = functionShortName.lastIndexOf('::');
        if (startOfName !== -1) {
          functionShortName = functionShortName.substr(startOfName + 2);
        }

        functionInfo = {
          id: key(functionAddress),
          name: functionSignature,
          symbol: functionSymbol,
          searchKey: functionName.toLowerCase(),
          shortName: functionShortName,
          isThunk: false,
          classes: [],
        };

        if (functionSymbol.substr(0, 4) !== '_ZTh') {
          out.functions.push(functionInfo);
        } else {
          functionInfo.isThunk = true;
          functionInfo.name = functionSignature.substr(21);
        }

        addressToFunctionMap[key(functionAddress)] = functionInfo;
      }

      functionInfo.classes.push(classInfo);
      currentVtable.push(functionInfo);

      sendProgressUpdate(false);
    }

    out.classes.push(classInfo);

    sendProgressUpdate(false);
  }

  sendProgressUpdate(true);
  self.postMessage(out);
};
