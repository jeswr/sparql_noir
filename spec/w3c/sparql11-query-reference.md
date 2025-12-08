# SPARQL 1.1 Query Language Reference

> Extracted from [W3C SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/)
> W3C Recommendation 21 March 2013

This document contains key excerpts from the W3C SPARQL 1.1 specification relevant to this project.

## 17.3 Operator Mapping

The SPARQL grammar identifies operators used to construct constraints. The table below associates each operator with appropriate operands and operator functions.

### XPath Tests (Type-Specific Equality)

| Operator | Arg 1 | Arg 2 | Function | Return |
|----------|-------|-------|----------|--------|
| A = B | numeric | numeric | op:numeric-equal(A, B) | xsd:boolean |
| A = B | simple literal | simple literal | op:numeric-equal(fn:compare(A, B), 0) | xsd:boolean |
| A = B | xsd:string | xsd:string | op:numeric-equal(fn:compare(STR(A), STR(B)), 0) | xsd:boolean |
| A = B | xsd:boolean | xsd:boolean | op:boolean-equal(A, B) | xsd:boolean |
| A = B | xsd:dateTime | xsd:dateTime | op:dateTime-equal(A, B) | xsd:boolean |

### SPARQL Tests (General RDF Term Equality)

| Operator | Arg 1 | Arg 2 | Function | Return |
|----------|-------|-------|----------|--------|
| A = B | RDF term | RDF term | RDFterm-equal(A, B) | xsd:boolean |
| A != B | RDF term | RDF term | fn:not(RDFterm-equal(A, B)) | xsd:boolean |

**Important:** When selecting the operator definition, the most specific parameters apply. For instance, when evaluating `xsd:integer = xsd:signedInt`, the definition for `=` with two numeric parameters applies, not the general RDF term version.

---

## 17.4.1.7 RDFterm-equal

```
xsd:boolean  RDF term term1 = RDF term term2
```

Returns TRUE if `term1` and `term2` are the same RDF term as defined in RDF Concepts; **produces a type error** if the arguments are both literal but are not the same RDF term*; returns FALSE otherwise.

`term1` and `term2` are the same if any of the following is true:

- term1 and term2 are equivalent IRIs as defined in 6.4 RDF URI References of CONCEPTS.
- term1 and term2 are equivalent literals as defined in 6.5.1 Literal Equality of CONCEPTS.
- term1 and term2 are the same blank node as described in 6.6 Blank Nodes of CONCEPTS.

### Example: Value Equivalence

```turtle
@prefix a: <http://www.w3.org/2000/10/annotation-ns#> .
@prefix dc: <http://purl.org/dc/elements/1.1/> .

_:b a:annotates <http://www.w3.org/TR/rdf-sparql-query/> .
_:b dc:date "2004-12-31T19:00:00-05:00"^^xsd:dateTime .
```

Query:
```sparql
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?annotates
WHERE { 
  ?annot a:annotates ?annotates .
  ?annot dc:date ?date .
  FILTER ( ?date = xsd:dateTime("2005-01-01T00:00:00Z") )
}
```

Result: `<http://www.w3.org/TR/rdf-sparql-query/>`

**Note:** The RDF terms are NOT the same (`"2004-12-31T19:00:00-05:00"` vs `"2005-01-01T00:00:00Z"`), but they have **equivalent values** (same point in time).

### Type Error Behavior*

Invoking RDFterm-equal on two typed literals tests for equivalent values. An extended implementation may support additional datatypes. An implementation processing a query that tests for equivalence on **unsupported datatypes** (with non-identical lexical form and datatype IRI) **returns an error**.

Example: `"iiii"^^my:romanNumeral = "iv"^^my:romanNumeral` → **error** (cannot determine equivalence)

---

## 17.4.1.8 sameTerm

```
xsd:boolean  sameTerm (RDF term term1, RDF term term2)
```

Returns TRUE if `term1` and `term2` are the **same RDF term** as defined in RDF Concepts; returns FALSE otherwise.

### Key Difference from RDFterm-equal (=)

Unlike `=` (RDFterm-equal):
- `sameTerm` **never produces a type error**
- `sameTerm` tests for **identical RDF terms**, not equivalent values
- `sameTerm` can safely test literals with unsupported datatypes

### Example: sameTerm with Unsupported Datatypes

```turtle
@prefix : <http://example.org/WMterms#> .
@prefix t: <http://example.org/types#> .

_:c1 :label "Container 1" .
_:c1 :weight "100"^^t:kilos .
_:c1 :displacement "100"^^t:liters .

_:c2 :label "Container 2" .
_:c2 :weight "100"^^t:kilos .
_:c2 :displacement "85"^^t:liters .
```

Query:
```sparql
SELECT ?aLabel ?bLabel
WHERE { 
  ?a :weight ?aWeight .
  ?b :weight ?bWeight .
  FILTER ( sameTerm(?aWeight, ?bWeight) && !sameTerm(?a, ?b) )
}
```

This works because `sameTerm("100"^^t:kilos, "100"^^t:kilos)` returns TRUE (identical terms).

Using `=` instead would produce an **error** because `t:kilos` is an unsupported datatype.

---

## Summary: = vs sameTerm

| Aspect | `=` (RDFterm-equal) | `sameTerm` |
|--------|---------------------|------------|
| Tests for | **Equivalent values** | **Identical RDF terms** |
| `"1"^^xsd:integer = "1.0"^^xsd:decimal` | TRUE (same value) | FALSE (different terms) |
| `"2005-01-01T00:00:00Z" = "2004-12-31T19:00:00-05:00"` (as xsd:dateTime) | TRUE (same instant) | FALSE (different lexical forms) |
| `"foo"^^my:type = "foo"^^my:type` | TRUE (identical) | TRUE (identical) |
| `"foo"^^my:type = "bar"^^my:type` | **ERROR** (unknown datatype) | FALSE |
| Blank nodes | Tests identity | Tests identity |
| IRIs | Tests equivalence | Tests identity |

---

## Implications for Circuit Implementation

In a ZK circuit:

1. **`sameTerm`** can be implemented as exact Field equality after encoding:
   ```
   sameTerm(A, B) ↔ Enc_t(A) == Enc_t(B)
   ```

2. **`=` (RDFterm-equal)** requires type-aware comparison:
   - For numeric types: value comparison after normalization
   - For dateTime: comparison after timezone normalization
   - For simple literals/strings: lexical comparison
   - For unsupported datatypes with different lexical forms: **must raise error**
   - For identical terms: always equal

3. **Current Implementation Note**: The existing `filter_to_noir` treats `=` and `sameTerm` identically. This is **incorrect** for:
   - Numeric literals with different lexical forms (`1` vs `1.0`)
   - DateTime values in different timezones
   - Different literals that represent the same value

---

## References

- [SPARQL 1.1 Query Language](https://www.w3.org/TR/sparql11-query/) - Full specification
- [RDF Concepts and Abstract Syntax](https://www.w3.org/TR/rdf-concepts/) - RDF term definitions
- [XQuery 1.0 and XPath 2.0 Functions and Operators](https://www.w3.org/TR/xpath-functions/) - Operator definitions
