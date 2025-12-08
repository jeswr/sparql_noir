import { SparqlOperator } from "@comunica/utils-expression-evaluator";
import { Algebra, Factory } from "sparqlalgebrajs";

const factory = new Factory();

export function operator(op: Algebra.OperatorExpression): Algebra.OperatorExpression {
  switch (op.operator) {
    case SparqlOperator.NOT_IN:
    case SparqlOperator.IN:
      const inExpr = factory.createOperatorExpression(SparqlOperator.LOGICAL_OR, op.args.slice(1).map(expr =>
        factory.createOperatorExpression(SparqlOperator.EQUAL, [op.args[0], expr])
      ));
      return op.operator === SparqlOperator.NOT_IN
        ? factory.createOperatorExpression(SparqlOperator.NOT, [inExpr])
        : inExpr;
    case SparqlOperator.IS_LITERAL:
      return factory.createOperatorExpression(SparqlOperator.NOT,
        [
          factory.createOperatorExpression(SparqlOperator.LOGICAL_OR,
            [SparqlOperator.IS_IRI, SparqlOperator.IS_BLANK].map(iop =>
              factory.createOperatorExpression(iop, [op.args[0]])
            ),
          ),
        ] 
      );
    case SparqlOperator.LT:
      return factory.createOperatorExpression(SparqlOperator.GT, [op.args[1], op.args[0]]);
    case SparqlOperator.LTE:
    case SparqlOperator.GTE:
      const args = (op.operator === SparqlOperator.LTE) ? [op.args[1], op.args[0]] : op.args;
      return factory.createOperatorExpression(SparqlOperator.LOGICAL_OR, [
        factory.createOperatorExpression(SparqlOperator.GT, args),
        factory.createOperatorExpression(SparqlOperator.EQUAL, args)
      ]);
    case SparqlOperator.IS_URI:
      return factory.createOperatorExpression(SparqlOperator.IS_IRI, [op.args[0]]);
    case SparqlOperator.NOT_EQUAL:
      return factory.createOperatorExpression(SparqlOperator.NOT,
        [factory.createOperatorExpression(SparqlOperator.EQUAL, op.args)]
      );
    default:
      return op;
  }
}
