# Standalone viewer sources

These are independent website copies. No runtime request is made to the data
review server on port 8792, and no annotation or save operation is included.

- `realappliance_usd.js` is copied from this research workspace's
  `src/data_process/review/shared_static/realappliance_usd.js`. The website copy
  adds an optional AbortSignal to model downloads so timed-out downloads can be cancelled. Original geometry, material and joint semantics are retained.
- `vendor/three.module.js`, `three.core.js`, `OrbitControls.js`,
  `RoomEnvironment.js`, `OBJLoader.js`, `MTLLoader.js`, `USDCParser.js` and `USDComposer.js` are copied from
  `src/data_process/review/shared_static/vendor/`. These are the existing Three.js
  r183 files and local USD helper versions used by the review viewer. Three.js
  license text is retained in `vendor/LICENSE`; existing file headers are preserved.
- `viewer.js` and `../gallery.js` are the independent paper-page UI integration.
- `../../tools/viewer-source-hashes.json` (relative to `website/`, under `tools/`)
  records source file hashes at the time of copying. Assets have a separate
  `provenance.json` per object. Source hashes describe provenance, not a license
  grant for dataset assets.

The USD parser retains its existing unsupported-array diagnostics. The adapter
applies materials after composition; the raw composer may log missing texture
messages before that step. These copies do not repair source geometry or certify
collision-free motion. Node checks cover geometry and joint transforms; actual
WebGL appearance requires a browser.
