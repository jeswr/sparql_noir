import { pathToCircuit } from '../dist/path.js';
import { translate } from 'sparqlalgebrajs';

const project = translate('SELECT * WHERE { ?s (<http://example.org/p1>/<http://example.org/p2>|<http://example.org/p3>)+ ?o }');

console.log(project);

console.log(pathToCircuit(project.input.predicate));
