Next steps:
 - We need to get written into GOAL.md the history of the project
 - Need to generate formal descriptions of the _encodings_ and _sparql_ mappings
 - Need to define the APIs that we want to produce and publish as packages. Ideally we would publish to both `crates.io` and `npm` a package with the following methods -- offered both as CLI parameters:
   - Sign: Sign a dataset (note that this is essentially the functionality that [vc-cli.js](https://github.com/jeswr/vc-cli.js) already provides) -- with the ability to configure signatures and hashes used.
   - Prove: Generate a proof that a SPARQL query holds over a set of data -- which should offer the ability to configure (a) hashes used, and (b) signature types used, in addition to having a good _default_ setting.
   - Verify: Verify that a proof is correct. This verification _should_ perform any required verification on the output, such as checking filter constraints hold on disclosed values -- if that is not checked within the circuit. This means that the prover needs to explicitly define the algorithm used for proving so that the verifier can apply the correct verification algorithm.
   - There should be an `--info` option for each `Prove`r algorithm that describes any data which is disclosed in addition to the expected output of the query (e.g., type of signatures used, depth of path traversal in the result, number of signatures etc. -- this includes anything that comes from the fixed architecture e.g. if the architecture limits paths to a depth of 5, then you are disclosing the fact that the result of an ex:examplePath+ was obtained in 5 or less hops).
 - Nothing about these API's should tie us to Noir, and the proof should be entirely self-descriptive as to the underlying proof engines required to do verification.

Note that since we are now doing the conversion using rust, the `npm` package will need to use WebAssembly.
