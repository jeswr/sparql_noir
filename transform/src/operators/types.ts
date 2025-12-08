import { SparqlOperator, declare } from "@comunica/utils-expression-evaluator";

// We now define functions on RDF Terms
// § 17.4.2 Functions on RDF Terms (https://www.w3.org/TR/sparql11-query/#func-rdfTerms)
enum TermType {
  RDFTerm,
  XSDBoolean,
  XSDString,
  Literal,
  SimpleLiteral,
  IRI,
  BlankNode,

  XSDInteger,
  Numeric,
}

// interface BoolComparison {
//   args: [TermType, TermType];
//   comparons
// }



// Architectural choices:
// Since we 

enum LiteralElem {
  value,
  encoded,
  language,
  datatype,
}

enum BinaryFieldOperation {
  EQ,
  NEQ,
}

interface FieldComparison {
  type: "field";
  value: string;
}

interface LiteralComparison {
  type: "literal";
  value: string;
}

export default {
  // [SparqlOperator.STRLEN]: {
  //   input: {
  //     type: "",
  //     output: ""
  //   },
  //   output: 1,
  // }
  [SparqlOperator.LANG]: {
    input: {
      type: "",
      output: ""
    },
    output: {
      type: "string",
      args: 1,
    }
  }
} as const;
