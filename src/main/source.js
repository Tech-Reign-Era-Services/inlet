'use strict';

// Where a file was downloaded from (kMDItemWhereFroms). Thin wrapper over provenance.js,
// kept because the scanner and rules only need the URL list.
const { readOne, hostOf } = require('./provenance');

async function getSources(filePath) {
  if (process.platform !== 'darwin') return [];
  const prov = await readOne(filePath);
  return prov ? prov.urls : [];
}

module.exports = { getSources, hostOf };
