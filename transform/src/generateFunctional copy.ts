import fs from "fs";
import { Algebra, Factory, translate } from "sparqlalgebrajs";
import { DataFactory as DF } from "n3";
import { getTermEncodings, getTermEncodingString, hash2, hash4 } from "./encode.js";
import { simplifyExpression, simplifyExpressionEBV } from "./expressionSimplifier.js";
// import { optimize } from "./optimize.js";
import { getIndex } from "./termId.js";
import { operator as equivalentOperators } from "./equivalentOperators.js";
import { BindConstraint, CircomTerm, Computed, ComputedBinary, ComputedBinaryType, Constraint, Static, Var } from "./types.js";
import { SparqlOperator, Operator } from "@comunica/utils-expression-evaluator";

function optimize(constraint: Constraint): Constraint {
  return constraint;
}


type A = Exclude<SparqlOperator, SparqlOperator.ABS>;

function operator(iop: Algebra.OperatorExpression): Constraint {
  const op = equivalentOperators(iop);
  switch (op.operator) {
    case SparqlOperator.LOGICAL_AND: return { type: "all", constraints: op.args.map(constraintExpression) };
    case SparqlOperator.LOGICAL_OR: return { type: "some", constraints: op.args.map(constraintExpression) };
    // TODO: Make sure this is correct insofar as numerics are concerned and expressions like FILTER(isLITERAL(?friend) == true)
    case SparqlOperator.EQUAL:
      if (op.args.length !== 2) throw new Error("Expected two arguments for =");
      return { type: "=", left: valueExpression(op.args[0]), right: valueExpression(op.args[1]) };
    case SparqlOperator.NOT: 
      if (op.args.length !== 1) throw new Error("Expected one argument for !");
      return { type: "not", constraint: constraintExpression(op.args[0]) };
    case SparqlOperator.IS_IRI:
    case SparqlOperator.IS_BLANK:
      if (op.args.length !== 1) throw new Error(`Expected one argument for ${op.operator}`);
      return { type: "unary", constraint: valueExpression(op.args[0]), operator: op.operator };
    case SparqlOperator.GT:
      return {
        type: "binary",
        left: valueExpression(op.args[0]),
        right: valueExpression(op.args[1]),
        operator: SparqlOperator.GT,
      }
    default:
      throw new Error(`Unsupported operator: ${op.operator}`);
  }
}

function valueExpression(iop: Algebra.Expression): Var | Static | Computed | ComputedBinary {
  const op = simplifyExpression(iop);
  switch (op.expressionType) {
    case Algebra.expressionTypes.TERM: return termExpression(op);
    case Algebra.expressionTypes.OPERATOR:
      const op2 = equivalentOperators(op);
      switch (op2.operator) {
        case "isliteral":
          return { type: "computed", input: valueExpression(op2.args[0]), computedType: SparqlOperator.IS_LITERAL };
        case "isiri":
          return { type: "computed", input: valueExpression(op2.args[0]), computedType: SparqlOperator.IS_IRI };
        case "isblank":
          return { type: "computed", input: valueExpression(op2.args[0]), computedType: SparqlOperator.IS_BLANK };
        case "lang":
          return { type: "computed", input: valueExpression(op2.args[0]), computedType: SparqlOperator.LANG };
        case "=":
          if (op.args.length !== 2) throw new Error("Expected two arguments for =");
          return { type: "computedBinary", left: valueExpression(op2.args[0]), right: valueExpression(op2.args[1]), computedType: SparqlOperator.EQUAL };
        case SparqlOperator.GT:
          if (op.args.length !== 2) throw new Error("Expected two arguments for >= and <=");
          return { type: "computedBinary", left: valueExpression(op2.args[0]), right: valueExpression(op2.args[1]), computedType: SparqlOperator.GT };
        default:
          throw new Error(`Unsupported operator: ${op.operator}`);
      }
    default:
      throw new Error(`Unsupported expression: [${op.expressionType}]\n${JSON.stringify(op, null, 2)}`);
  }
}

function termExpression(op: Algebra.TermExpression): Var | Static {
  switch (op.term.termType) {
    case "Literal": return { type: "static", value: op.term };
    case "Variable": return { type: "variable", value: op.term.value };
    default:
      throw new Error(`Unsupported term type: ${op.term.termType}`);
  }
}

function constraintExpression(op: Algebra.Expression): Constraint {
  const iop = simplifyExpressionEBV(op);

  if (typeof iop === 'boolean') {
    return {
      type: "boolean",
      value: iop,
    };
  }

  switch (iop.expressionType) {
    case Algebra.expressionTypes.OPERATOR: return operator(iop);
    default:
      throw new Error(`Unsupported expression: ${op.expressionType}`);
  }
}

function filter(op: Algebra.Filter): OutInfo {
  const { expression, input } = op;
  const res = operation(input);
  return {
    inputPatterns: res.inputPatterns,
    binds: res.binds,
    constraint: {
      type: "all",
      constraints: [
        res.constraint,
        constraintExpression(expression),
      ],
    },
    optionalPatterns: res.optionalPatterns,
  };
}

interface OutInfo {
  inputPatterns: Algebra.Pattern[];
  optionalPatterns: Algebra.Pattern[];
  binds: BindConstraint[];
  constraint: Constraint;
}

function handlePatterns(patterns: (Algebra.Pattern | Algebra.Path)[]): OutInfo {
  const variables: Set<string> = new Set();
  const constraints: (Constraint | BindConstraint)[] = [];
  const outputPatterns: Algebra.Pattern[] = [];
  const optionalPatterns: Algebra.Pattern[] = [];

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];

    if (pattern.graph.termType !== "DefaultGraph") {
      throw new Error("Expected a default graph");
    }

    if (pattern.type === Algebra.types.PATH) {
      if (pattern.predicate.type === "ZeroOrOnePath") {
        if (pattern.predicate.path.type !== Algebra.types.LINK) {
          console.warn("ZeroOrOnePath is not supported, skipping", pattern);
          continue;
        }

        optionalPatterns.push(
          (new Factory()).createPattern(
            pattern.subject,
            pattern.predicate.path.iri,
            pattern.object,
            pattern.graph,
          )
        );
        constraints.push({
          type: "some",
          constraints: [
            // CASE 1: ZERO PATH - SUBJECT AND OBJECT VARIABLE ARE THE SAME
            {
              type: "=",
              left: { type: "variable", value: pattern.subject.value },
              // FIX: REFERENCE THE OPTIONAL INPUT PATTERN
              right: { type: "variable", value: pattern.object.value },
            },
            // CASE 2: ONE PATH - SUBJECT AND OBJECT VARIABLE ARE DIFFERENT
            // HERE WE NEED TO DO AN EQUALITY CHECK ON THE FULL TRIPLE
            {
              type: "all",
              constraints: [
                // TODO: FIX THE Is
                {
                  type: "=",
                  left: { type: "variable", value: pattern.subject.value },
                  right: { type: "input", value: [i, 0] },
                },
                {
                  type: "=",
                  // TODO: SEE WHAT PATHS OTHER THAN LINK EXIST AND PROPERLY TYPE CHECK
                  left: { type: "static", value: pattern.predicate.path.iri },
                  right: { type: "input", value: [i, 1] },
                },
                {
                  type: "=",
                  left: { type: "variable", value: pattern.object.value },
                  right: { type: "input", value: [i, 2] },
                },
              ],
            }
          ],
        });
        constraints.push({
          type: "=",
          left: { type: "variable", value: pattern.object.value },
          right: { type: "input", value: [i, 2] },
        });
        // TODO: REMOVE ALL BINDS AND MAKE THEM EQUALITY CONSTRAINTS; THEN WE CAN JUST
        // SUPPLY THESE VALUES TO THE CIRCUIT AND THE ABOVE EQUALITY CONSTRAINTS WILL BE
        // WILL BE VALID
        continue;
      } else {
        // TODO: Make this return to an error condition
        console.warn("Unsupported operation: " + pattern.type);
        continue;
        // throw new Error("Unsupported operation: " + pattern.type);
      }
    }

    outputPatterns.push(pattern);

    for (let j = 0; j < 3; j++) {
      const term = pattern[(['subject', 'predicate', 'object'] as const)[j]];

      if (term.termType === "Variable") {
        constraints.push({
          type: variables.has(term.value) ? "=" : "bind",
          left: { type: "variable", value: term.value },
          right: { type: "input", value: [i, j] },
        });
        variables.add(term.value);
      } else if (term.termType === "NamedNode" || term.termType === "Literal") {
        constraints.push({
          type: "=",
          left: { type: "static", value: term },
          right: { type: "input", value: [i, j] },
        });
      } else {
        throw new Error("Unexpected term type: " + term.termType);
      }
    }
  }

  return {
    inputPatterns: outputPatterns,
    optionalPatterns: optionalPatterns,
    binds: constraints.filter((c): c is BindConstraint => c.type === "bind"),
    constraint: {
      type: "all",
      constraints: constraints.filter((c): c is Constraint => c.type !== "bind"),
    },
  };
}

function bgp(op: Algebra.Bgp): OutInfo {
  return handlePatterns(op.patterns);
}

function extend(op: Algebra.Extend): OutInfo {
  const { input, expression } = op;
  const res = operation(input);
  return {
    ...res,
    binds: [
      ...res.binds,
      {
        type: "bind",
        left: { type: "variable", value: op.variable.value },
        right: valueExpression(expression),
      },
    ],
  };
}

function join(op: Algebra.Join): OutInfo {
  const patterns: (Algebra.Pattern | Algebra.Path)[] = [];

  for (const i of op.input) {
    switch (i.type) {
      case Algebra.types.PATH:
        patterns.push(i);
        break;
      case Algebra.types.BGP:
        patterns.push(...i.patterns);
        break;
      case Algebra.types.EXTEND:
        console.warn("perfomring nop");
        // patterns.push();
        break;
      default:
        throw new Error("Unsupported operation: " + i.type);
    }
  }

  return handlePatterns(patterns);
}

function operation(op: Algebra.Operation): OutInfo {
  switch (op.type) {
    case Algebra.types.FILTER: return filter(op);
    case Algebra.types.BGP: return bgp(op);
    case Algebra.types.EXTEND: return extend(op);
    case Algebra.types.JOIN: return join(op);
    default:
      throw new Error(`Unsupported operation: ${op.type}`);
  }
}

function topLevel(op: Algebra.Operation) {
  switch (op.type) {
    case Algebra.types.PROJECT: return project(op);
    default:
      throw new Error(`Unsupported top level operation: ${op.type}`);
  }
}

interface ProjectInfo extends OutInfo {
  variables: string[];
}

function project(op: Algebra.Project): ProjectInfo {
  return {
    variables: op.variables.map(v => v.value),
    ...operation(op.input),
  }
}

interface CircuitOptions {
  termSize: number;
  version: string;
}

function hashTerm(term: CircomTerm | C2): string {
  switch (term.type) {
    case "variable": return term.value;
    case "input": return `input[${term.value[0]}]`;
    case "static": return `static[${getIndex(term.value).join(",")}]`;
    case "computed": return `computed[${hashTerm(term.input)}][${term.computedType}]`;
    case "computedBinary": return `computedBinary[${hashTerm(term.left)}][${hashTerm(term.right)}][${term.computedType}]`;
    case "customComputed":
      return `customComputed[${hashTerm(term.input)}][${term.computedType}]`;
  }
}

interface C2 {
  type: 'customComputed';
  input: CircomTerm;
  computedType: string;
}



// Main generation function
export function generateCircuit(queryFilePath: string = "./inputs/sparql.rq", options: CircuitOptions = { termSize: 128, version: '2.1.2' }) {
  const query = fs.readFileSync(queryFilePath, "utf8");
  const state = topLevel(translate(query));

  const hiddenInputs: (CircomTerm | C2)[] = [];
  const bindings: Record<string, CircomTerm> = {};
  const constraints: string[] = [];
  const ands: Set<string> = new Set();

  for (const bind of state.binds) {
    if (!state.variables.includes(bind.left.value) && !(bind.left.value in bindings)) {
      // Rather than creating extra hidden variables, we just use the existing variable where possible
      bindings[bind.left.value] = bind.right;
    }
    // Handle LANG computed type for language-tagged literals
    else if (bind.right.type === 'computed' && bind.right.computedType === 'lang' && bind.right.input.type === 'variable') {
      // Add hidden inputs for the literal value and its special handling
      const literalValueIndex = hiddenInputs.length;

      const input = bind.right.input.type === 'variable' && bind.right.input.value in bindings
        ? bindings[bind.right.input.value]
        : bind.right.input;

      hiddenInputs.push(
        { type: 'customComputed', computedType: 'literal_value', input },
        { type: 'customComputed', computedType: 'literal_lang', input },
        { type: 'customComputed', computedType: 'literal_value', input: bind.left },
      );

      constraints.push(`${serializeTerm(bind.right.input)} == ${getTermEncodingString(DF.literal('', 'en'), {
        lang: `hidden[${literalValueIndex + 1}]`,
        valueEncoding: `hidden[${literalValueIndex}]`,
        literalEncoding: `hidden[${literalValueIndex}]`,
      })}`);
      constraints.push(`${serializeTerm(bind.left)} == ${getTermEncodingString(DF.literal('', 'en'), {
        lang: `hidden[${literalValueIndex + 1}]`,
        valueEncoding: `hidden[${literalValueIndex + 2}]`,
        literalEncoding: `hidden[${literalValueIndex + 2}]`,
      })}`);
    } else
      constraints.push(`${serializeTerm(bind.left)} == ${serializeTerm(bind.right, true)}`);
  }

  function serializeTerm(term: CircomTerm, assignment: boolean = false): string {
    switch (term.type) {
      case "static":
        return getTermEncodings([term.value])[0].toString();
      case "variable":
        if (state.variables.includes(term.value))
          return 'variables.' + term.value;
        else
          return serializeTerm(bindings[term.value]);
      case "input":
        return `bgp[${term.value[0]}].terms[${term.value[1]}]`;
      default:
        throw new Error(`Unsupported term type: ${term.type}`);
    }

    // switch (term.type) {
    //   case "variable":
        // if (state.variables.includes(term.value))
        //   return `pub[${state.variables.indexOf(term.value)}]`;
        // else
        //   return (anonymousVariables[term.value] ??= `hid[${id++}]`);
    //   case "input":  return `triples[${term.value[0]}][${term.value[1]}]`;
    //   case "static": return `[${getIndex(term.value).join(", ")}]`;
    //   // case "computed": 
    //   //   imports.add("./operators.circom");
    //   //   return `${term.computedType}()(${serializeTerm(term.input)})`;
    //   case "computed": 
    //     imports.add("./operators.circom");
    //     return writeAnonymous(`${term.computedType}()(${serializeTerm(term.input)})`, assignment);
    //   case "computedBinary":
    //     imports.add("./operators.circom");
    //     return writeAnonymous(`${term.computedType}()(${serializeTerm(term.left)}, ${serializeTerm(term.right)})`, assignment);
    // }
  }

  function createConstraint(constraint: Constraint): string {
    switch (constraint.type) {
      case "all":
      case "some":
        if (constraint.constraints.length <= 1) throw new Error("Expected at least two constraints");
        return `${constraint.constraints.map(elem => `(${createConstraint(elem)})`).join(constraint.type === "all" ? " & " : " | ")}`;
      case "not":
        return `(${createConstraint(constraint.constraint)}) == false`;
      case "=":
        if (
          constraint.left.type === 'computed' 
          && constraint.left.input.type === 'variable'
          && constraint.left.computedType === 'lang' 
          && constraint.right.type === 'static'
          && constraint.right.value.termType === 'Literal'
          && constraint.right.value.datatype?.value === 'http://www.w3.org/2001/XMLSchema#string'
        ) {
          hiddenInputs.push(
            { type: 'customComputed', computedType: 'literal_value', input: constraint.left.input.value in bindings
              ? bindings[constraint.left.input.value] : constraint.left.input },
          );

          return `${serializeTerm(constraint.left.input)} == ${getTermEncodingString(DF.literal('', constraint.right.value.value), {
            valueEncoding: `hidden[${hiddenInputs.length - 1}]`,
            literalEncoding: `hidden[${hiddenInputs.length - 1}]`,
          })}`
  
          throw new Error("Cannot compare computed lang with static value directly");
        }
        return `${serializeTerm(constraint.left)} == ${serializeTerm(constraint.right)}`;
      case "unary":
        switch (constraint.operator) {
          case "isiri":
          case "isblank":
              const term = constraint.constraint.type === "variable" && bindings[constraint.constraint.value]
                ? bindings[constraint.constraint.value]
                : constraint.constraint;

              let index = hiddenInputs.findIndex(elem => hashTerm(elem) === hashTerm(term));
              if (index === -1) {
                hiddenInputs.push(term);
                index = hiddenInputs.length - 1;
              }

              return `${serializeTerm(constraint.constraint)} == ${hash2}([${
                constraint.operator === "isiri" ? "0" : "1"
              }, hidden[${index}]])`;
          default:
            throw new Error("Unsupported unary operator: " + constraint);
        }
      case "binary":
        switch (constraint.operator) {
          case SparqlOperator.GT:
            // Helper function to extract numeric value from any CircomTerm
            const extractNumericValue = (term: CircomTerm): { valueHiddenIndex: number, specialHiddenIndex: number, staticValue?: number } => {
              const resolvedTerm = term.type === 'variable' && term.value in bindings ? bindings[term.value] : term;
              
              if (resolvedTerm.type === 'static') {
                if (resolvedTerm.value.termType === 'Literal' && 
                    resolvedTerm.value.datatype?.value === 'http://www.w3.org/2001/XMLSchema#integer') {
                  // For static integer literals, we can use the value directly
                  return { 
                    valueHiddenIndex: -1, 
                    specialHiddenIndex: -1, 
                    staticValue: parseInt(resolvedTerm.value.value, 10) 
                  };
                }
              }
              
              // For all other cases (variables, computed terms, etc.), add hidden inputs
              const valueIndex = hiddenInputs.length;
              hiddenInputs.push(
                {
                  type: 'customComputed',
                  computedType: 'literal_value',
                  input: resolvedTerm,
                },
                {
                  type: 'customComputed',
                  computedType: 'special_handling',
                  input: resolvedTerm,
                }
              );

              // Add constraint to ensure the term matches the integer literal encoding
              const encoding = getTermEncodingString(DF.literal('', DF.namedNode('http://www.w3.org/2001/XMLSchema#integer')), {
                valueEncoding: `hidden[${valueIndex}]`,
                literalEncoding: `hidden[${valueIndex + 1}]`,
              });
              constraints.push(`${encoding} == ${serializeTerm(term)}`);

              return { valueHiddenIndex: valueIndex, specialHiddenIndex: valueIndex + 1 };
            };

            const leftValue = extractNumericValue(constraint.left);
            const rightValue = extractNumericValue(constraint.right);

            // Generate the comparison expression
            let leftExpr: string;
            let rightExpr: string;

            if (leftValue.staticValue !== undefined) {
              leftExpr = leftValue.staticValue.toString();
            } else {
              leftExpr = `(hidden[${leftValue.specialHiddenIndex}] as i32)`;
            }

            if (rightValue.staticValue !== undefined) {
              rightExpr = rightValue.staticValue.toString();
            } else {
              rightExpr = `(hidden[${rightValue.specialHiddenIndex}] as i32)`;
            }

            return `${leftExpr} > ${rightExpr}`;
        }
      default:
        throw new Error("Unsupported constraint type: " + JSON.stringify(constraint, null, 2));
    }
  }

  // Get an optimized set of constraints
  const topLevelConstraint = optimize(state.constraint);

  for (const c of topLevelConstraint.type === "all" ? topLevelConstraint.constraints : [topLevelConstraint])
    constraints.push(createConstraint(c));

  let output = 'use crate::types::Triple;\n\n';

  output += `pub(crate) type BGP = [Triple; ${state.inputPatterns.length}];\n`;
  if (hiddenInputs.length > 0)
    output += `pub(crate) type Hidden = [Field; ${hiddenInputs.length}];\n`;

  output += `pub(crate) struct Variables {\n`;
  for (const variable of state.variables) {
    output += `  pub(crate) ${variable}: Field,\n`;
  }
  output += `}\n\n`;

  output += `pub(crate) fn checkBinding(bgp: BGP, variables: Variables${hiddenInputs.length > 0 ? ', hidden: Hidden' : ''}) {\n`;

  for (const constraint of constraints) {
    output += `  assert(${constraint});\n`;
  }

  output += `}\n`;
  return {
    circuit: output,
    main: fs.readFileSync("./template/main-verify.template.nr", "utf8")
      .replace("{{h0}}", hiddenInputs.length > 0 ? ", Hidden" : "")
      .replace("{{h1}}", hiddenInputs.length > 0 ? ",\n    hidden: Hidden" : "")
      .replace("{{h2}}", hiddenInputs.length > 0 ? ", hidden" : "")
      .replace("{{hash2}}", hash2)
      .replace("{{hash4}}", hash4),
    metadata: {
      variables: state.variables,
      inputPatterns: state.inputPatterns,
      optionalPatterns: state.optionalPatterns,
      hiddenInputs: hiddenInputs,
    },
  };
}

// Run the generator if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const { circuit, metadata, main } = generateCircuit();
  fs.writeFileSync("./noir_prove/src/sparql.nr", circuit);
  fs.writeFileSync("./noir_prove/src/main.nr", main);
  fs.writeFileSync("./noir_prove/metadata.json", JSON.stringify(metadata, null, 2));
  // fs.writeFileSync("circuits/artefacts/query.json", JSON.stringify(metadata, null, 2));
}
