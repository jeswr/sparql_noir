import { SyncEvaluator } from "@comunica/expression-evaluator";
import { Algebra, Factory } from "sparqlalgebrajs";
import { BindingsFactory } from "@comunica/bindings-factory";

export function simplifyExpression(expression: Algebra.Expression): Algebra.Expression {
  const bindingsFactory = new BindingsFactory();
  const factory = new Factory();
  const evaluator = new SyncEvaluator(expression);
  try {
    return factory.createTermExpression(evaluator.evaluate(bindingsFactory.bindings([])));
  } catch (error) {
    // TODO: See if there is more that can be done within the expression
    return expression;
  }
}

export function simplifyExpressionEBV(expression: Algebra.Expression): boolean | Algebra.Expression {
  const bindingsFactory = new BindingsFactory();
  const evaluator = new SyncEvaluator(expression);
  try {
    return evaluator.evaluateAsEBV(bindingsFactory.bindings([]));
  } catch (error) {
    // TODO: See if there is more that can be done within the expression
    return expression;
  }
}
