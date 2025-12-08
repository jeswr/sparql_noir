import { Term } from "@rdfjs/types";
import { SparqlOperator, declare } from "@comunica/utils-expression-evaluator";

export type CircomTerm = Var | Input | Static | Computed | ComputedBinary;
export interface Var {
  type: "variable";
  value: string;
}
interface Input {
  type: "input";
  value: [number, number];
}
export interface Static {
  type: "static";
  value: Term;
}

export enum ComputedBinaryType {
  EQUAL = "equal",
  GEQ = ">=",
}
export interface Computed {
  type: "computed";
  input: CircomTerm;
  computedType: SparqlOperator;
}
export interface ComputedBinary {
  type: "computedBinary";
  left: CircomTerm;
  right: CircomTerm;
  computedType: SparqlOperator;
}
export interface BindConstraint {
  type: "bind";
  left: Var;
  right: CircomTerm;
}
interface EqConstraint {
  type: "=";
  left: CircomTerm;
  right: CircomTerm;
}
interface AllConstraint {
  type: "all";
  constraints: Constraint[];
}
interface SomeConstraint {
  type: "some";
  constraints: Constraint[];
}
interface NotConstraint {
  type: "not";
  constraint: Constraint;
}
interface UnaryCheckConstraint {
  type: "unary";
  constraint: CircomTerm;
  operator: "isiri" | "isblank" | "isliteral";
}
interface BinaryCheckConstraint {
  type: "binary";
  left: CircomTerm;
  right: CircomTerm;
  operator: SparqlOperator;
}
interface BooleanConstraint {
  type: "boolean";
  value: boolean;
}
export type Constraint = EqConstraint | AllConstraint | SomeConstraint | NotConstraint | UnaryCheckConstraint | BooleanConstraint | BinaryCheckConstraint;
