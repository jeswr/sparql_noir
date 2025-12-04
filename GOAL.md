There is a large amount of technical debt associated with that codebase. The overall goal of the project has been to write a tool that will convert a SPARQL 1.1 query into a zero-knowledge circuit -- in order to prove that a set of query results are true; without disclosing any information about the signed datasets _except_ for the fact that the underlying datasets were signed by a given set of public keys.


I am trying to create this codebase based on the contents of the `legacy` codebase.

Within the legacy codebase, I was in the middle of trying to update some of the SPARQL -> Noir code generation from Typescript to Rust. This was with the assistance of generative AI and I had not vetted the code.

Within the typescript codebase, I had also been doing a migration from using circom as an abstraction for generating ZKcircuits to noir. As a result, there are legacy references to circom specific concepts within that code that I would like to remove.

Please identify all key architectural decisions around how:
 - Data mappings are represented represented formally - this should follow (https://www.w3.org/TR/rdf11-concepts/ and https://www.overleaf.com/project/68da9681f9cfa6d332c6869b)
 - SPARQL is conceptually mapped to noir circuits, or subsets of constraints are mapped to SPARQL queries. As is the case in some of the designs that I want to get towards.

---

Here is an example of how we can think about defining the encodings; where `h_2` and `h_4` are configurable hash functions. We should also be adding a full definition of the custom handling of literal datatypes so as to enable the 

Enc: T -> F_p
Enc_t: $L$ U $B$ U $I$ U {DEFAULT_GRAPH} -> F_p
Enc_s: 
h_2: F_p x F_p -> F_p
h_4: F_p x F_p x F_p x F_p -> F_p

Enc(T) = h_4(Enc_s(T_s), Enc_p(T_p), Enc_o(T_o), Enc(T_g))
Enc(T) = h_4(Enc_t(T_s), Enc_t(T_p), Enc_o(T_o), Enc(T_g))



---

I would like for there to be a description of these representations defined in a _concise, formal, declarative_ manner - which can then be used as the authorotative source of truth with which to:
 - Generate code,
 - Write a paper describing the architecture of the codebase,
 - Generate a machine-readable analysis of the security features of the codebase, and
 - Write a W3C specification using re-spec (https://w3c.github.io/respec/) using the same terminology / concepts as the Verifiable Credential Data Model (https://www.w3.org/TR/vc-data-model-2.0/).
Ideally we should reach a point where the code, analysis and spec are all generated directly from this declarative source -- in addition to the paper being a combination of code generated and LLM generated.
