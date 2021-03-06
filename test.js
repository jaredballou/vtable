var fs = require('fs');
var elf = require('./vtable.js');

//console.log(elf, elf.process);

function toArrayBuffer(buffer) {
  var ab = new ArrayBuffer(buffer.length);
  var view = new Uint8Array(ab);
  for (var i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i];
  }
  return ab;
}

function hex(n) {
  return ('0000000' + ((n|0)+4294967296).toString(16)).substr(-8);
}

fs.readFile('engine_srv.so', function(err, data) {
  if (err) {
    throw err;
  }

  var programInfo = elf.process(toArrayBuffer(data));
  if (programInfo.error.length > 0) {
    throw programInfo.error;
  }

  console.log("address size: " + programInfo.addressSize);
  console.log("rodata start: " + hex(programInfo.rodataStart));
  console.log("rodata chunks: " + programInfo.rodataChunks.size());
  for (var i = 0; i < programInfo.rodataChunks.size(); ++i) {
    var chunk = programInfo.rodataChunks.get(i);
    console.log("  offset: " + hex(chunk.offset));
    console.log("    size: " + hex(chunk.data.length));
  }

  console.log("symbols: " + programInfo.symbols.size());
  var printed = 0;
  for (var i = 0; i < programInfo.symbols.size(); ++i) {
    var symbol = programInfo.symbols.get(i);
    if (symbol.address === 0 || symbol.size === 0 || symbol.name.length === 0) {
      continue;
    }
    console.log("  offset: " + hex(symbol.address));
    console.log("    size: " + hex(symbol.size));
    console.log("    name: " + symbol.name);
    if (++printed >= 10) break;
  }
});
