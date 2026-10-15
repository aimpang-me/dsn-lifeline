# Step 0 gate

Gate-only code. Do not deploy it. A run polls NASA's DSN Now feed.

`src/extract.js` is the pure parser used by the local tests (`test/step0.test.js`). `src/index.js` is a throwaway Worker that would poll `https://eyes.nasa.gov/dsn/data/dsn.xml` once a minute for one hour and store poll records plus up to five raw XML bodies. It is not imported by `npm test`.
