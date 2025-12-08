Please now update the Architecture.md based on this conversation and develop a plan for implementing the desired architecture using the existing code that is available.

There are a few things from the old/legacy architecture that I would like to remove -- specifically, I do not want the heavy use of templating; instead in noir files see how signatures and hashes are handled in the new top level /noir folder of this codebase where these values are imported from a consts file.

For now, I also do not want any of the signing done in rust; instead just keep using the src/scripts/sign.ts file for this.

Until we add the bindings for a cargo package; the only thing that should be done using rust - is the conversion of a SPARQL query into a noir circuit.


---

One way of implementing `OPTIONAL` is to not do any form of circuit customisation -- and instead, find the solution set to a given query; and generate SPARQL queries without the `OPTIONAL` statement that correctly correspond to that set of bindings.

This would then enable 
