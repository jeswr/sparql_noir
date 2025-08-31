import { Algebra, Factory } from "sparqlalgebrajs";
import { createHash } from "crypto";
import { iriToField } from "./FIELD_MODULUS.js";
const hash = (str: string) => createHash('sha256').update(str).digest('hex');

const factory = new Factory();

interface Path {
  path: string;
  imports: Map<string, Path>;
}

export function pathToCircuit(path: Algebra.PropertyPathSymbol): Path {
  switch (path.type) {
    case Algebra.types.LINK:
      return {
        path: `((triple.terms[0] == s) & (triple.terms[2] == o) & (triple.terms[1] == ${iriToField(path.iri.value)}))`,
        imports: new Map(),
      };
    case Algebra.types.SEQ:
      if (path.input.length < 2)
        throw new Error("Sequence paths must have more than 2 inputs");

      const subPaths = path.input.map((input) => pathToCircuit(input));
      const imports: [string, Path][] = subPaths.map((sp) => [`f${hash(sp.path)}`, sp]);

      const res = imports.map((sp, i) => {
        return `${sp}(vk[${i}], proof[${i}], [${i == 0 ? 's' : `v[${i}]`}, ${i == subPaths.length - 1 ? 'o' : `v[${i + 1}]`}], 0x0, HONK_IDENTIFIER)`;
      });

      return {
        path: res.join(" & "),
        imports: new Map(imports)
      }
    case Algebra.types.ALT:
      if (path.input.length < 2)
        throw new Error("Alternation paths must have more than 2 inputs");

      const altSubPaths = path.input.map((input) => pathToCircuit(input));
      const altImports: [string, Path][] = altSubPaths.map((sp) => [`f${hash(sp.path)}`, sp]);

      const altRes = altImports.map((sp, i) => {
        return `${sp[0]}(vk[${i}], proof[${i}], [s, o], 0x0, HONK_IDENTIFIER)`;
      });

      return {
        path: altRes.join(" | "),
        imports: new Map(altImports)
      }
    case Algebra.types.ZERO_OR_MORE_PATH:
      const subPath = pathToCircuit(path.path);
      const fname = `f${hash(subPath.path)}`;

      return {
        path: `((s == o) | ${fname}(vk, proof, [s, o], 0x0, HONK_IDENTIFIER))`,
        imports: new Map([[fname, subPath]])
      };
    case Algebra.types.ONE_OR_MORE_PATH:
      const zeroOrMoreInner = pathToCircuit(factory.createZeroOrMorePath(path.path));
      const inner = pathToCircuit(path.path);
      const f1 = `f${hash(inner.path)}`;
      const f2 = `f${hash(zeroOrMoreInner.path)}`;

      return {
        path: `(${f1}(vk, proof, [s, v1], 0x0, HONK_IDENTIFIER) & ${f2}(vk, proof, [v1, o], 0x0, HONK_IDENTIFIER))`,
        imports: new Map([[f1, inner], [f2, zeroOrMoreInner]])
      };
    default:
      throw new Error(`Unsupported path type: ${path.type}`);
  }
}
