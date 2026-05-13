# Readable Per-Operator Algebra Library — Specification

**Status:** Round-1 design (parallel to monolithic surface).
**Scope:** Defines a Noir-side struct hierarchy where each SPARQL
algebra operator and each expression head is a first-class type with a
small `evaluate`/`check` method. The Rust transform's job becomes
choosing which structs to instantiate from the parsed algebra tree;
the per-operator semantics live in the Noir library, not in
`transform/src/lib.rs` strings.

This document **complements** [`spec/algebra.md`](./algebra.md), which
specifies the monolithic surface used by today's transform. The
readable rewrite emits a structurally equivalent satisfaction
predicate but exposes it as a tree of typed values rather than a
flat concatenation of `assert`s. The monolithic surface stays in place
for the paper's baseline benchmarks; this surface targets
reviewer-friendliness and Lean correspondence (see
[`SPARQL_ROADMAP.md`](../SPARQL_ROADMAP.md) §6).

**British English throughout. References to PAG = Pérez–Arenas–
Gutiérrez (TODS 34(3), 2009); W3C §18 = SPARQL 1.1 §18 algebra.**

---

## 1. Design principles

1. **One struct per algebra operator.** A reviewer should be able to
   open `bgp.nr` and see the entire BGP semantics in one screen.
2. **Composition is by value, not by string-templating.** A
   `Filter<E>` wraps a child algebra and a child expression. The
   transform builds these trees in Rust; the Noir library runs them.
3. **`evaluate` returns a boolean.** Every operator's primary method
   returns a `bool` that is `true` iff the operator's contract is
   satisfied for the supplied witness. The top-level `main`
   `assert`s the boolean of the root operator. This matches the way
   the monolithic surface produces a single conjunction at the end,
   and it keeps the semantics close to the PAG paper's
   `[[ · ]]_D : Pat → Ω` (a set-of-mappings characterisation that
   reduces in the witness model to a satisfaction predicate).
4. **Const-generic sizes.** Each operator that contains repeated
   sub-structures (e.g., `Bgp<N>` for an `N`-pattern BGP) takes its
   width as a const generic, picked by the transform per query.
5. **One trait, monomorphic composition.** A single `trait Algebra
   { fn evaluate(self) -> bool }` is the common interface; every
   operator implements it. Combinators (`Filter<P, E>`, `Join<L, R>`,
   etc.) carry concrete child types as generics with `T: Algebra`
   bounds. Noir requires trait bounds to call methods on generic
   parameters (see `/noir-lang/noir` docs); without one, the
   composition does not type-check. The trait stays minimal — only
   `evaluate`.
6. **Self-contained operators.** Every operator struct owns the
   witness data it needs (its triples, its sentinels, its pre-baked
   pattern positions, its expression-value witnesses). There is no
   `BindingCtx` argument: the per-query binding values are baked
   into the struct fields at construction time by the transform.
   `Bgp<N>` therefore holds `triples: [Triple; N]`, `root_value:
   Field`, and `patterns: [TriplePattern; N]`. `evaluate` consumes
   `self` and returns `bool`.
7. **Round-1 scope = single-graph, no aggregates, bounded paths**
   per the paper's stated fragment (`SPARQL_ROADMAP.md` §1).
   Aggregates, MINUS-via-NOT-EXISTS, EXISTS, subqueries, REGEX, and
   non-IEEE arithmetic string functions are listed below as
   **deferred**.

---

## 2. Term & witness model

The library reuses the existing `dep::types` shapes verbatim. No new
types are introduced at the term level:

```rust
// from dep::types
pub struct TermWitness { hash: Field, bytes: [u8; STRING_LEN_MAX], length: u32 }
pub struct Triple       { terms: [TermWitness; 4], path: [...], directions: [...] }
```

There is **no `BindingCtx` argument** to any `evaluate` method. The
per-query binding values are baked into the operator struct fields
at construction time. For example, where the monolithic surface
emits `assert(variables.s == bgp[0].terms[0].hash)`, the readable
surface stores `variables.s` (a `Field`) inside `TriplePattern.
subject.expected`, and the `evaluate` body emits
`bgp[0].terms[0].hash == self.patterns[0].subject.expected`.

The per-query `main.nr` still declares a public-input `variables`
struct (one field per projected variable) — the transform projects
those `Field` values into the operator struct constructors. The
public-input shape of `variables` is unchanged from the monolithic
surface; only the *internal routing* changes.

The library does provide a *helper struct* for triple-pattern
positions:

```rust
/// One position in a triple pattern. Either a fixed term-hash
/// (constant in the query) or a reference into the binding context
/// (the transform writes one constructor per case).
pub struct PatternPos { pub expected: Field }
```

The transform compiles each pattern position into a `PatternPos`
whose `expected` field is either a constant hash or a binding-context
field projection. The operator structs only ever compare
`bgp[i].terms[j].hash == pos.expected`.

---

## 3. Algebra operators

For every operator we list **fields**, **method signature(s)**, and
**public input contract** (what gets exposed to `main`'s public
input list). The "public input contract" is what the orchestrating
`main.nr` declares; the operator struct itself takes them as method
arguments.

### 3.1 `Bgp<N>` — Basic Graph Pattern

**Reference:** PAG §3.1; W3C §18.2.2.5.

```rust
pub struct Bgp<let N: u32> {
    pub triples: [Triple; N],
    pub patterns: [TriplePattern; N],
    pub root_value: Field,
}

pub struct TriplePattern {
    pub subject: PatternPos,
    pub predicate: PatternPos,
    pub object: PatternPos,
}

impl<let N: u32> Algebra for Bgp<N> {
    /// Returns `true` iff every witness triple in `self.triples`:
    /// (a) is a member of the dataset committed in `self.root_value`,
    ///     proven by its Merkle path; and
    /// (b) matches the corresponding pattern's subject/predicate/
    ///     object positions. The 4th (graph) position is not
    ///     asserted here -- `GraphCtx<N>` (sec.3.9) attaches the
    ///     per-triple `terms[3].hash == graph_iri.expected`
    ///     assertion for `GRAPH`-qualified patterns; default-graph
    ///     patterns inherit the monolithic-surface elision.
    fn evaluate(self) -> bool {
        // For each i in 0..N: verify_inclusion(triples[i], root_value)
        // and assert terms[j].hash == patterns[i].<pos>.expected for
        // j in {0,1,2}. Conjunction returned. The graph slot is
        // GraphCtx's responsibility.
    }
}
```

**Public-input contract:** none directly; the per-query `main.nr`
declares the witness triples, root, and the signature check on the
root. The `Bgp` struct owns the triples + root after construction.

**Constraint sketch (per pattern):** `verify_inclusion` (≈ Merkle
depth `M` × `hash2` plus one `hash4`) plus 3 field equalities (the
4th is conditional on `GraphCtx` wrapping). The inclusion cost
dominates by an order of magnitude (`M = 11` Merkle depth × Pedersen
hashes).

**Soundness anchor:** matches `assert(bgp[i].terms[j].hash ==
expected)` for j in {0,1,2} and the `verify_inclusion(triple,
root_value)` body in `main.nr` exactly. The graph slot follows the
monolithic emit's convention: elided for default-graph queries
(soundness via the dataset commitment's Merkle binding of the
(s, p, o, g) tuple); asserted by `GraphCtx::evaluate` for
`GRAPH`-qualified patterns. The round-2 follow-up split (move the
graph assertion from `Bgp::evaluate` into `GraphCtx::evaluate`) is
the fix landed for the `basic_bgp` regression noted in
`bench/readable-vs-monolithic.md`.

### 3.2 `Join<L, R>` — Join

**Reference:** PAG §3.1; W3C §18.2.2.6.

```rust
pub struct Join<L, R> where L: Algebra, R: Algebra {
    pub left: L,
    pub right: R,
}

impl<L, R> Algebra for Join<L, R> where L: Algebra, R: Algebra {
    fn evaluate(self) -> bool {
        self.left.evaluate() & self.right.evaluate()
    }
}
```

**Binding consistency:** handled at the leaf — each `TriplePattern`
compares its positions against `ctx.<var>` baked into `PatternPos.
expected`. Two BGP patterns naming the same SPARQL variable both
point at the same `Field` value (the same `variables.<var>` public
input), so equality is transitive through the public-input layer.
No explicit cross-pattern assertion is needed.

### 3.3 `Union<L, R>` — Union

**Reference:** W3C §18.2.4.

```rust
pub struct Union<L, R> where L: Algebra, R: Algebra {
    pub left: L,
    pub right: R,
}

impl<L, R> Algebra for Union<L, R> where L: Algebra, R: Algebra {
    fn evaluate(self) -> bool {
        self.left.evaluate() | self.right.evaluate()
    }
}
```

**Note.** Today's monolithic surface flattens UNION branches into a
single `bgp` array whose width is the widest branch; the unused
slots in each branch are unconstrained. The readable surface
preserves this convention: each branch operator gets a sub-slice of
the flat `bgp` array sized to that branch's needs. A future
optimisation could let each branch's BGP array shrink to its actual
size by passing sliced arrays — Noir supports `[T; N]`-sized parameters
naturally — but it complicates the public-input layout, so round 1
sticks with the monolithic convention.

### 3.4 `LeftJoin<L, R>` — OPTIONAL

**Reference:** PAG §3.2; W3C §18.5.

Round 1 covers the **easy-case OPTIONAL** (round-3 collapse in
`spec/exists.md` §4.1) where all of the OPTIONAL's variables are
either outer-bound or constant after substitution. The collapsed
form is:

```rust
pub struct LeftJoin<L, R> {
    pub mandatory: L,
    pub optional_arm: OptionalArm<R>,
}

pub struct OptionalArm<R> {
    pub right: R,                  // the inner pattern (matched arm)
    pub absent_hash: Field,        // hash4 of the substituted absent triple
    pub bracket: NonMembershipBracket,  // sentinel-aware bracket
}

impl<L, R> LeftJoin<L, R> {
    pub fn evaluate(self, ...) -> bool {
        let matched = self.optional_arm.right.evaluate(...);
        let unmatched = self.optional_arm.bracket.verify(self.optional_arm.absent_hash);
        self.mandatory.evaluate(...) & (matched | unmatched)
    }
}
```

**Power-set OPTIONAL** (the hard case — when the OPTIONAL's
variables are not all outer-bound) is **deferred**. The monolithic
surface handles it by emitting `2^n` circuit variants; the readable
rewrite would either replicate that scheme or introduce a new
prefix-tree commitment. Since round-4 prefix-tree work is in flight
in the main repo (`spec/prefix-tree-commitment.md`), the readable
surface defers until that lands and provides a one-circuit collapse.

### 3.5 `Filter<P, E>` — Filter

**Reference:** W3C §18.2.5.4.

```rust
pub struct Filter<P, E> where P: Algebra, E: ExprBool {
    pub inner: P,    // child algebra
    pub expr: E,     // boolean expression (see §4)
}

impl<P, E> Algebra for Filter<P, E> where P: Algebra, E: ExprBool {
    fn evaluate(self) -> bool {
        self.inner.evaluate() & self.expr.evaluate()
    }
}
```

**EBV semantics.** SPARQL FILTER takes the *effective boolean value*
of the expression. Round-1 expressions return a plain `bool` that is
already the EBV; the EBV-typed error case (e.g., `1 < "foo"`)
follows today's transform behaviour of either rejecting at lowering
time or using the `noir/lib/ebv::EBVResult` type for explicit error
modelling. The expression structs in §4 carry a comment on each
arm's error model.

### 3.6 `Extend<P, B>` — BIND

**Reference:** W3C §18.2.5.3.

```rust
pub struct Extend<P, B> where P: Algebra, B: ExprBool {
    pub inner: P,
    /// `binding` is a boolean predicate produced by the transform:
    /// `Eq { left: Var { value: variables.<new_var> },
    ///       right: <computed-Field-expression> }`. The transform
    /// constructs the RHS as a `Lit`, a `Var`, or (round 2) an
    /// arithmetic Field-expression once `ExprField` lands.
    pub binding: B,
}

impl<P, B> Algebra for Extend<P, B> where P: Algebra, B: ExprBool {
    fn evaluate(self) -> bool {
        self.inner.evaluate() & self.binding.evaluate()
    }
}
```

Today's monolithic surface only supports `BIND` with Variable /
NamedNode / Literal right-hand sides; arithmetic in BIND is rejected
at transform time (`SPARQL_ROADMAP.md` §2.1). The readable
surface inherits this restriction unchanged in round 1; the
`binding` field is one of `BindVar`, `BindLit`, `BindIri` from §4.

### 3.7 `Project<P>` — Project

**Reference:** W3C §18.2.5.2.

```rust
pub struct Project<P> {
    pub inner: P,
}
```

Project is a no-op at the circuit level — projection happens by
*which* fields the per-query `BindingCtx` carries. The struct
exists for symmetry with the algebra tree (the transform builds a
`Project<...>` at the root) and to make the Lean correspondence
clean (the Lean side mirrors the same tree).

```rust
pub struct Project<P> where P: Algebra { pub inner: P }
impl<P> Algebra for Project<P> where P: Algebra {
    fn evaluate(self) -> bool { self.inner.evaluate() }
}
```

### 3.8 `Distinct<P>` / `Reduced<P>` / `Order<P>` / `Slice<P>` — post-process

**Reference:** W3C §18.2.4.1–18.2.5.

All four are **post-process** in the monolithic surface
(`SPARQL_ROADMAP.md` §2.1): the verifier collects the binding-set
across multiple proofs and applies the modifier outside the circuit.
The readable rewrite preserves this — these structs exist only as
type-level markers in the algebra tree so the Lean correspondence
can identify them:

```rust
pub struct Distinct<P> { pub inner: P }
pub struct Reduced<P>  { pub inner: P }
pub struct Order<P>    { pub inner: P }
pub struct Slice<P>    { pub inner: P, pub offset: u32, pub limit: u32 }

// All four have `evaluate = inner.evaluate`.
```

The transform threads these through unchanged; they emit no
additional in-circuit constraints in round 1.

### 3.9 `GraphCtx<N>` — Graph

**Reference:** W3C §18.2.5.5.

```rust
pub struct GraphCtx<let N: u32> {
    pub inner: Bgp<N>,
    pub graph_iri: PatternPos,   // either a fixed IRI or `?g`
}

impl<let N: u32> Algebra for GraphCtx<N> {
    fn evaluate(self) -> bool {
        // Inner BGP semantics (subject/predicate/object + Merkle
        // inclusion) plus the per-triple graph-position pin.
        let mut result = self.inner.evaluate();
        for i in 0..N {
            result = result &
                (self.inner.triples[i].terms[3].hash
                    == self.graph_iri.expected);
        }
        result
    }
}
```

`GraphCtx<N>` owns the per-triple 4th-position assertion
`triple.terms[3].hash == graph_iri.expected`. The inner `Bgp<N>`
checks the first three positions and Merkle inclusion; the 4th
position is `GraphCtx`'s responsibility. **Default-graph queries do
not construct a `GraphCtx`** and therefore pay zero graph-position
assertion cost -- matching the monolithic surface's elision exactly.
This split is the round-2 follow-up fix for the `basic_bgp`
backend-gate regression documented in
`bench/readable-vs-monolithic.md`.

**Round-1 composition scope:** `GraphCtx<N>` wraps `Bgp<N>` directly
(the corpus has `GRAPH <iri> { ?s p ?o }` and `GRAPH ?g { ?s p ?o }`
forms). Higher composition (`GraphCtx<Join<...>>`,
`GraphCtx<Union<...>>`) is deferred to round-2 alongside the
multi-BGP graph plumbing. The wrapper's type signature trades the
fully-generic `<P>` for a concrete `Bgp<N>` so that the per-triple
assertion can reach the inner witness array; future round-2
generalisations either add a `GraphAssertable` trait that BGP / Join
/ Union implement, or expose the inner triples via an associated
type. For round-1 this trade-off is the correct one: the corpus
doesn't exercise the higher composition, and the concrete shape is
what unlocks the elision win.

### 3.10 `PathLink<P>`, `PathInverse<P>`, `PathNps<P>` — atomic paths

**Reference:** W3C §18.4.

```rust
pub struct PathLink {
    pub predicate: PatternPos,
    pub triple: TriplePattern,
}

pub struct PathInverse<P> { pub inner: P }   // semantic swap of subject/object
pub struct PathNps<P>     { pub inner: P, pub excluded: [Field; M] }
```

A property path of the form `?s ex:knows ?o` becomes a `PathLink`
whose `triple` is the obvious `TriplePattern`. The `PathInverse`
wrapper is a marker for the algebra tree; in practice the transform
swaps subject/object positions inside the inner `TriplePattern` so
`PathInverse::evaluate` is just `inner.evaluate`. The `PathNps`
struct holds the list of excluded predicates as a const-sized array;
its `evaluate` adds a conjunction `(bgp[i].terms[1].hash != excluded[k])`
for each `k`.

Sequence / `+` / `*` paths are unrolled at transform time to a
`Union` of `Join`s of `PathLink`s (matching today's monolithic
behaviour); no dedicated struct is needed.

---

## 4. Expressions

Filter and Extend expressions form their own struct family. Each
expression head is a struct; composition is by value just like the
algebra side. Every expression struct exposes
`evaluate(ctx) -> bool` for boolean expressions, or
`evaluate_field(ctx) -> Field` for value expressions used as
RHS of `BIND`. Round 1 covers the FILTER fragment that the
monolithic transform supports today (`SPARQL_ROADMAP.md` §2.3).

### 4.1 Atoms

```rust
pub struct Var { pub value: Field }     // ctx.<name> projected to a Field
pub struct Lit { pub value: Field }     // pre-encoded constant hash
```

`Var` is built by the transform as `Var { value: ctx.<name> }`.
`Lit` carries the precomputed term hash for an RDF literal.

### 4.2 Comparison

Hash-domain comparison atoms (compare two `Field` values directly):

```rust
pub struct EqF       { pub left: Field, pub right: Field }
pub struct NeqF      { pub left: Field, pub right: Field }
pub struct SameTerm  { pub left: Field, pub right: Field }
```

Why the `F` suffix: Noir's prelude reserves the trait names `Eq`,
`Ord`, etc.; we suffix `F` ("field") to disambiguate. `SameTerm` is
equivalent to `EqF` under our canonical encoding (per
`spec/encoding.md`); the type-level distinction exists so the Lean
correspondence can keep them separate.

Ordered comparison is *value-typed*. Round 1 follows the monolithic
surface and decodes the i64 numeric value from the hidden-input
witness (`hidden[k]` in today's emit):

```rust
pub struct VarI64 { pub value: i64 }                    // sourced from a hidden input
pub struct LtI64  { pub left: VarI64, pub right: VarI64 }
pub struct LeI64  { pub left: VarI64, pub right: VarI64 }
pub struct GtI64  { pub left: VarI64, pub right: VarI64 }
pub struct GeI64  { pub left: VarI64, pub right: VarI64 }
```

Round-2 would unify these once the hidden-input plumbing is
unified across the library (see `noir/lib/arith`).

### 4.3 Logical

```rust
pub struct And<L, R> { pub left: L, pub right: R }
pub struct Or<L, R>  { pub left: L, pub right: R }
pub struct Not<E>    { pub inner: E }
```

`evaluate` is the obvious boolean combinator. No surprises.

### 4.4 Term tests

```rust
pub struct Bound      { pub field: Field, pub bound: bool }
pub struct IsIri<E>   { pub inner: E, pub type_witness: u8 }
pub struct IsLiteral<E> { pub inner: E, pub type_witness: u8 }
pub struct IsBlank<E>   { pub inner: E, pub type_witness: u8 }
pub struct IsNumeric  { pub type_witness: u8, pub datatype_hash: Field }
```

`IsIri` / `IsLiteral` / `IsBlank` mirror today's `type_check`
shape — they consume a hidden-input `type_witness` (the term's
encoded type code) and assert the witness matches the encoded
value. The full encoding relationship lives in
`noir/lib/utils::verify_type_encoding` (referenced from
`spec/algebra.md` §6.6).

`IsNumeric` extends this with a second witness — `datatype_hash`,
the Pedersen hash of the literal's datatype IRI sourced from a
hidden input. The struct asserts both that the term is a literal
(`type_witness == 2`) and that `datatype_hash` matches one of the
four precomputed XSD numeric datatype hashes (`xsd:integer`,
`xsd:decimal`, `xsd:float`, `xsd:double`). The four constants are
materialised by accessor functions
(`xsd_integer_hash`, `xsd_decimal_hash`, `xsd_float_hash`,
`xsd_double_hash`) in `expr::is_numeric`. Derived numeric
datatypes (`xsd:long`, `xsd:int`, ...) are an easy follow-up once
the term-encoding contract grows a "numeric datatype family" tag.

### 4.7 IN / NOT IN

```rust
pub struct In<let N: u32>    { pub var: Field, pub set: [Field; N] }
pub struct NotIn<let N: u32> { pub var: Field, pub set: [Field; N] }
```

SPARQL §17.4.1.9: `expr IN (e1, ..., eN)` is sugar for
`(expr = e1) || ... || (expr = eN)`. Both sides are hash-domain
(`Field`), matching `EqF`'s convention — the transform projects
each set element into a precomputed term hash or a
`variables.<var>` public input. `evaluate` folds direct
`Field`-equality over `N` elements; `NotIn` is the boolean
inverse, implemented by re-evaluating `In` and negating.

The round-1 surface restricts the comparison to the hash domain.
Typed-value `IN` (mixing IRIs, literals, and numeric coercions per
XPath 2.0 value comparison) follows the same gap as `LtI64` /
`GtI64`: when the transform proves both sides are numerics it
lowers to a future `EqI64`; for term-identity it lowers to
`EqF`/`In`. This matches the monolithic surface's hash-equality
shortcut.

### 4.8 IF / COALESCE

```rust
pub struct IfBool<C, T, F>     { pub cond: C, pub then_branch: T, pub else_branch: F }
pub struct CoalesceBool<L, R>  { pub primary_bound: bool, pub primary: L, pub fallback: R }
```

**Boolean-context only.** Round-1 lacks an `ExprField` typed-value
expression family (see `traits.nr`). Both operators therefore take
boolean-typed branches (all of `C`/`T`/`F`/`L`/`R` are
`ExprBool`) and return a `bool`. The typed-value forms
(`IF(?c, ?x, ?y)` returning a `Field`, `COALESCE(?x, ?y)`
returning a `Field`) are deferred to round 2 alongside the rest
of the typed-value expression family. This is consistent with the
round-1 stance taken on numeric arithmetic.

`CoalesceBool` is binary; wider coalesces lower to a right-nested
chain at transform time (the same shape used for nested `OR`).
`primary_bound` is the transform-supplied static-analysis flag
(matches `expr::term_tests::Bound`).

### 4.9 isNumeric

`IsNumeric` is documented in §4.4 alongside the other term tests
(it shares the type-witness pattern). Listed separately in the
operator coverage matrix (§8) for clarity.

### 4.5 String / function calls

Round-1 scope:

- **STR / DATATYPE / LANG / LANGMATCHES** — supported via the
  hash-equality shortcut today (`emit.rs::handle_function_equality`).
  The readable surface wraps these as `StrEq`, `DatatypeEq`,
  `LangEq`, `LangMatches` structs that store a precomputed
  *expected hash* and assert equality.
- **CONTAINS / STRSTARTS / STRENDS** — supported via the round-2
  byte-witness binding (`spec/encoding.md` §6). The readable surface
  wraps these as `Contains<L, R>`, `StrStarts<L, R>`,
  `StrEnds<L, R>` where each side carries a byte witness; the
  `evaluate` method emits the lexical-form binding plus a call into
  `noir_xpath::{contains, starts_with, ends_with}`. The byte-witness
  binding is the soundness anchor and is documented at the call
  site.

```rust
pub struct Contains<L, R> { pub haystack: L, pub needle: R }
// ... StrStarts, StrEnds analogous
```

Other string functions (SUBSTR, UCASE, LCASE, STRBEFORE, STRAFTER,
CONCAT, REPLACE, ENCODE_FOR_URI, REGEX) are **deferred** —
`SPARQL_ROADMAP.md` §2.3 marks them all as not-implemented in the
monolithic surface either; the readable rewrite inherits this gap.

### 4.6 Arithmetic

The monolithic surface does **not** wire `noir/lib/arith` into
FILTER today (`SPARQL_ROADMAP.md` §2.4) — `Add/Sub/Mul/Div` between
operands is rejected at transform. The readable surface declares the
structs so the tree is faithful, but `evaluate` is a stub that
delegates to the existing `noir_xpath` IEEE-754 paths only when both
operands are statically known to be floats:

```rust
pub struct AddF64<L, R> { pub left: L, pub right: R }  // calls xpath::add_f64
pub struct SubF64<L, R> { pub left: L, pub right: R }
pub struct MulF64<L, R> { pub left: L, pub right: R }
pub struct DivF64<L, R> { pub left: L, pub right: R }
```

Integer arithmetic stays out of round 1 (the same gap exists in the
monolithic surface).

---

## 5. Composition example

A query like

```sparql
SELECT ?s ?o WHERE {
    ?s ex:age ?o .
    FILTER ((?o > "18"^^xsd:integer) && (?o < "30"^^xsd:integer))
}
```

becomes the following Rust-emitted struct tree (one struct per
algebra node), which the transform writes into `main.nr`:

```rust
let q = Project {
    inner: Filter {
        inner: Bgp {
            patterns: [TriplePattern {
                subject:   PatternPos { expected: ctx.s },
                predicate: PatternPos { expected: EX_AGE_HASH },
                object:    PatternPos { expected: ctx.o },
            }],
        },
        expr: And {
            left:  GtI64 { left: VarI64 { value: hidden[0] as i64 }, right: VarI64 { value: hidden[1] as i64 } },
            right: LtI64 { left: VarI64 { value: hidden[2] as i64 }, right: VarI64 { value: hidden[3] as i64 } },
        },
    },
};
assert(q.evaluate(bgp, ctx, hidden));
```

The `hidden[i]` slots and their binding to the underlying term hashes
are still part of the public-input contract — `main.nr` declares
them — but the per-operator semantics now live in the library, not
in the per-query emit code.

---

## 6. Public-input contract

Per-query `main.nr` declares the contract; the readable library
operators only consume the witness arguments. The contract is
unchanged from the monolithic surface:

- `public_key: [PubKey; N_DATASETS]` (public)
- `roots: [Root; N_DATASETS]` (private)
- `bgp: [Triple; N_PATTERNS]` (private)
- `bgp_prefix3: [PrefixTriple3; ...]` (private; only when prefix-3
  primitives are in scope)
- `low_sentinel`, `high_sentinel`, `low_sentinel_3`, `high_sentinel_3`
  (private; only when non-membership primitives are in scope)
- `boundary_cases: [Field; ...]`, `boundary_cases_prefix3: [Field; ...]`
  (public; one per non-membership constraint)
- `hidden: [Field; ...]` (private; per-query hidden inputs for
  numeric comparisons / type witnesses)
- `variables: BindingCtx` (public)

This shape is unchanged from `transform/template/main-verify.template.nr`
and `transform/template/main-simple.template.nr`. The readable
surface does not introduce new public inputs in round 1.

---

## 7. Future work

- **Round-1 includes the trait already.** As built, the library
  declares `trait Algebra { fn evaluate(self) -> bool }` and
  `trait ExprBool { fn evaluate(self) -> bool }` in
  `noir/lib/algebra/src/algebra/traits.nr`. Every operator
  implements one of them. The round-1 surface is monomorphic per
  query (the transform writes out concrete instantiations) but the
  trait bound is what makes `Filter<P, E>::evaluate` able to call
  `inner.evaluate()` -- without it, Noir rejects the method call
  on a generic type parameter (see `/noir-lang/noir` docs,
  "Calling functions on generic parameters").
- **Power-set OPTIONAL collapse.** Round-4 prefix-tree commitments
  promise a single-circuit collapse; the readable surface will
  expose a single `LeftJoin` struct rather than `2^n` variants once
  that lands.
- **MINUS / EXISTS / NOT EXISTS structs.** Once the non-membership
  primitive set stabilises in `noir/lib/utils`, these become single
  `Minus<L, R>` / `Exists<P>` structs that wrap the existing
  primitives. Currently held by the same blocker as OPTIONAL
  power-set collapse.
- **Aggregates.** Out of round-1 scope (paper fragment). Will need a
  sort proof first; see `SPARQL_ROADMAP.md` §3.
- **REGEX, full string-function family.** Out of round-1 scope;
  needs the byte-level string handling that round-2 began. The
  readable surface will pick these up as the library primitives
  land.

---

## 8. Operator coverage matrix (round 1)

| Algebra op | In readable lib? | Monolithic parity | Notes |
|---|---|---|---|
| BGP | Y | Y | `Bgp<N>` |
| Join | Y | Y | `Join<L, R>` (composition only) |
| Union | Y | Y | `Union<L, R>` |
| LeftJoin (easy collapse) | Y | Y | `LeftJoin<L, R>` |
| LeftJoin (power-set) | N | Y (via `optional_circuits[]`) | Deferred; round-4 dependency |
| Filter | Y | Y | `Filter<P, E>` |
| Extend (BIND, var/lit/iri RHS) | Y | Y | `Extend<P, B>` |
| Project | Y | Y | no-op wrapper |
| Distinct / Reduced / Order / Slice | Y (markers) | Post | no-op wrappers |
| Graph | Y | Y | `GraphCtx<N>` (wraps `Bgp<N>` directly; round-2 generalises) |
| PathLink / Inverse / NPS | Y | Y | atomic structs |
| Path sequence / `+` / `*` | Y (via Union/Join) | Y | unrolled at transform time |
| Minus | N | N | deferred |
| Service | N | N (OOS) | permanently OOS |
| Aggregate (COUNT, SUM, …) | N | N | deferred |

| Expression head | In readable lib? | Notes |
|---|---|---|
| Var, Lit, SameTerm | Y | atoms |
| EqF, NeqF, SameTerm | Y | hash-domain identity |
| LtI64, LeI64, GtI64, GeI64 | Y | i64 numeric (hidden-input plumbing) |
| And, Or, Not | Y | boolean combinators |
| Bound | Y | via static-analysis bool |
| isIRI / isLiteral / isBlank | Y | via `type_witness: u8` hidden input |
| isNumeric | Y | `type_witness == 2` + `datatype_hash` ∈ {xsd:integer, decimal, float, double} |
| IN / NOT IN | Y | `In<N>` / `NotIn<N>` over hash domain; folded equality |
| IF / COALESCE | Y (boolean-context only) | `IfBool` / `CoalesceBool`; typed-value forms deferred to round 2 |
| STR / DATATYPE / LANG / LANGMATCHES (hash-eq) | N (round 2) | not in round-1 library; lower as `EqF` for now |
| CONTAINS / STRSTARTS / STRENDS | N (round 2) | byte-witness binding -- ready once `noir/lib/xpath` calls are exposed |
| SUBSTR / UCASE / LCASE / STRBEFORE / STRAFTER / CONCAT / REPLACE / ENCODE_FOR_URI | N | deferred |
| REGEX | N | deferred |
| EXISTS / NOT EXISTS | N | deferred |
| Numeric arithmetic (IEEE-754 add/sub/mul/div) | N (round 2) | gap inherited from monolith; stub structs documented in sec.4.6 |
| Integer arithmetic | N | gap inherited from monolith |

---

## 9. File layout

The library lives under `noir/lib/algebra/`:

```
noir/lib/algebra/
├── Nargo.toml
└── src/
    ├── lib.nr                  # re-exports
    ├── algebra.nr              # sub-module declarations
    ├── algebra/
    │   ├── traits.nr           # trait Algebra, trait ExprBool
    │   ├── bgp.nr              # Bgp<N>, TriplePattern, PatternPos
    │   ├── join.nr             # Join<L, R>
    │   ├── union.nr            # Union<L, R>
    │   ├── leftjoin.nr         # LeftJoin<L, A>, OptionalArm<M, U>
    │   ├── filter.nr           # Filter<P, E>
    │   ├── extend.nr           # Extend<P, B>
    │   ├── project.nr          # Project<P>, Distinct/Reduced/Order/Slice
    │   ├── graph.nr            # GraphCtx<N>
    │   └── path.nr             # PathLink, PathInverse, PathNps<M>
    ├── expr.nr                 # sub-module declarations
    └── expr/
        ├── atoms.nr            # Var, Lit, VarI64
        ├── cmp.nr              # EqF, NeqF, SameTerm, LtI64/LeI64/GtI64/GeI64
        ├── logical.nr          # And<L,R>, Or<L,R>, Not<E>
        ├── term_tests.nr       # Bound, IsIri, IsLiteral, IsBlank
        ├── in_set.nr           # In<N>, NotIn<N>
        ├── if_coalesce.nr      # IfBool<C,T,F>, CoalesceBool<L,R>
        └── is_numeric.nr       # IsNumeric (+ xsd_*_hash accessors)
```

String-function and arithmetic structs (`StrEq`, `Contains`,
`AddF64`, ...) are listed in section sec.4.5-sec.4.6 above but are
**deferred to round 2** -- they would slot in as additional files
in `src/expr/` once the underlying byte-witness and IEEE-754
arithmetic primitives are wired through `noir/lib/xpath` /
`noir/lib/arith` from the transform layer.

Each file is small enough to fit on a screen; review of a single
operator does not require reading any other file. This is the whole
point of the rewrite.

---

## 10. Correspondence with Lean

The Lean correspondence proof (`lean-proofs` agent's domain) mirrors
this tree one-for-one:

- Each Noir struct gets a Lean structure with the same name.
- Each `evaluate` method gets a Lean function with the same shape.
- The conjunction structure of the Noir circuit corresponds to the
  conjunction structure of the Lean predicate.
- Operator coverage gaps in the Noir library show up as `axiom`s on
  the Lean side, isolating the trust boundary.

This is the architectural reason for the rewrite — the monolithic
string-templated circuit cannot be mirrored as cleanly because the
Lean side would need to reconstruct the algebra from the emitted
string, which is brittle. With the readable surface, the Lean tree
and the Noir tree share the same shape.

---

## References

- [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/)
  — §18 algebra.
- Pérez, Arenas, Gutiérrez, *Semantics and Complexity of SPARQL*,
  ACM TODS 34(3), 2009 — compositional semantics that the algebra
  structure mirrors.
- [`spec/algebra.md`](./algebra.md) — monolithic-surface contract.
- [`spec/encoding.md`](./encoding.md) — term-hash + byte-witness
  encoding contract.
- [`spec/exists.md`](./exists.md) — non-membership / OPTIONAL
  collapse contract.
- [`SPARQL_ROADMAP.md`](../SPARQL_ROADMAP.md) — feature coverage
  matrix and round phasing.
