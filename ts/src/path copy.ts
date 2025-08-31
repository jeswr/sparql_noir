import { UltraHonkBackend, Barretenberg, RawBuffer } from "@aztec/bb.js";
import { CompiledCircuit, Noir } from "@noir-lang/noir_js";
import { Algebra, Factory } from "sparqlalgebrajs";
import { iriToField } from "./FIELD_MODULUS.js";

const factory = new Factory();

interface Path {
  path: string;
  subPaths: Map<string, Path>;
}

export function pathToCircuit(path: Algebra.PropertyPathSymbol): Path {
  switch (path.type) {
    case Algebra.types.LINK:
      return {
        path: `(triple.terms[0] == s) & (triple.terms[2] == o) & (triple.terms[1] == ${iriToField(path.iri.value)})`,
        subPaths: new Map(),
      };
    case Algebra.types.SEQ:
      // const { paths: seqPaths, allSubPaths: seqAllSubPaths } = collectPathCircuits(path.input);
      // let tripleIds = 0;

      // return {
      //   path: `(triple[${tripleId}].terms[1] == ${iriToField(path.iri.value)})`,
      //   subPaths: seqAllSubPaths,
      // };

      if (path.predicate.input.length < 2)
        throw new Error("Sequence paths must have more than 2 inputs");

      const { paths: seqPaths, allSubPaths: seqAllSubPaths } = collectPathCircuits(path.input);
    case Algebra.types.ALT:
      if (path.predicate.input.length < 2)
        throw new Error("Alternation paths must have more than 2 inputs");

      const { paths, allSubPaths } = collectPathCircuits(path.input);

      return {
        path: Array.from(paths).sort().join(" | "),
        subPaths: allSubPaths
      }
    case Algebra.types.ZERO_OR_MORE_PATH:
      const subPath = pathToCircuit(factory.createOneOrMorePath(path.path), 0, left, right);
      return {
        path: `(${left} == ${right}) | ${subPath.path}`,
        subPaths: subPath.subPaths
      };
    case Algebra.types.ONE_OR_MORE_PATH:
      const oneOrMoreInner = pathToCircuit(path.path, 0, left, right);
      return {
        path: `(${left} == ${right}) | ${oneOrMoreInner.path}`,
        subPaths: oneOrMoreInner.subPaths
      };
    default:
      throw new Error(`Unsupported path type: ${path.type}`);
  }
  throw new Error("Unreachable");
}

function collectPathCircuits(path: Algebra.PropertyPathSymbol[]) {
  const subElems = path.map((elem) => pathToCircuit(elem));

  const allSubPaths = new Map<string, Path>();
  const paths: string[] = [];
  for (const { path, subPaths } of subElems) {
    subPaths.forEach((subPath) => allSubPaths.set(subPath.path, subPath));
    paths.push(path);
  }
  return { paths, allSubPaths };
}
