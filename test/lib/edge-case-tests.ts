/**
 * Edge Case Negative Tests for SPARQL → Noir Transform (v2)
 * 
 * This module defines comprehensive negative test cases that test
 * edge cases in RDF term encoding and SPARQL semantics.
 * 
 * For each test, we explicitly define:
 * - The query
 * - Valid data that should produce a passing proof
 * - An invalid BGP triple (manually constructed) that should fail
 * - The expected error type
 * 
 * The invalid inputs are manually specified as RDF terms, NOT derived from data.
 * This allows us to test exact encoding mismatches.
 */

import N3 from 'n3';
import type { Term, Quad, Literal, NamedNode } from '@rdfjs/types';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const DF = N3.DataFactory;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const EX = 'http://example.org/';

/**
 * Invalid triple definition - explicitly defines what the invalid BGP should contain
 */
export interface InvalidTriple {
  subject: Term;
  predicate: Term;
  object: Term;
  graph: Term;
}

/**
 * Invalid variable bindings - what variables the invalid input claims to have
 */
export type InvalidVariables = Record<string, Term>;

/**
 * Edge case test definition (v2) - explicitly defines invalid inputs
 */
export interface EdgeCaseTestV2 {
  name: string;
  description: string;
  category: 'type-confusion' | 'datatype-mismatch' | 'iri-literal-confusion' | 
            'datetime-encoding' | 'boolean-encoding' | 'language-tag' | 'blank-node';
  query: string;
  /** Valid RDF data (Turtle format) */
  validData: string;
  /** Expected error description */
  expectedError: string;
  /** 
   * Explicitly defined invalid inputs - the terms we will encode and pass to the circuit.
   * These should NOT match the expected pattern encoding even though they might "look" similar.
   */
  invalidInputs: {
    /** The triple(s) to encode for the BGP - these will have valid merkle proofs from invalidDataForSigning */
    triple: InvalidTriple;
    /** The variables to pass - these are the "claimed" bindings */
    variables: InvalidVariables;
    /** RDF data to sign to get valid merkle proofs for the invalid triple */
    dataForSigning: string;
  };
}

/**
 * Generate all edge case tests (v2)
 */
export function generateEdgeCaseTestsV2(): EdgeCaseTestV2[] {
  return [
    // =====================================================
    // TYPE CONFUSION TESTS - String vs Typed Literal
    // =====================================================
    
    // String "3" should not match integer 3
    {
      name: 'string_vs_integer_3',
      description: 'String literal "3" should not match integer literal 3 in circuit',
      category: 'type-confusion',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :value 3 }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "3"^^xsd:integer .
`,
      expectedError: 'Object term encoding mismatch: string "3" is encoded differently than integer 3',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("3"),  // Plain string, not integer!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :value "3" .
`,
      },
    },

    // String "1" should not match integer 1
    {
      name: 'string_vs_integer_1',
      description: 'String literal "1" should not match integer literal 1',
      category: 'type-confusion',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :value 1 }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      expectedError: 'Object term encoding mismatch: string "1" is encoded differently than integer 1',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("1"),  // Plain string, not integer!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :value "1" .
`,
      },
    },

    // String "true" should not match boolean true
    {
      name: 'string_vs_boolean_true',
      description: 'String literal "true" should not match boolean true',
      category: 'type-confusion',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :flag true }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :flag "true"^^xsd:boolean .
`,
      expectedError: 'Object term encoding mismatch: string "true" is encoded differently than boolean true',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}flag`),
          object: DF.literal("true"),  // Plain string, not boolean!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :flag "true" .
`,
      },
    },

    // Integer vs double
    {
      name: 'integer_vs_double',
      description: 'Integer 1 encoded differently than double 1.0e0',
      category: 'type-confusion',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :value "1"^^xsd:integer }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      expectedError: 'Object term encoding mismatch: xsd:double vs xsd:integer',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("1.0e0", DF.namedNode(`${XSD}double`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1.0e0"^^xsd:double .
`,
      },
    },

    // Decimal vs integer
    {
      name: 'decimal_vs_integer',
      description: 'Decimal 1.0 encoded differently than integer 1',
      category: 'type-confusion',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :value "1"^^xsd:integer }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      expectedError: 'Object term encoding mismatch: xsd:decimal vs xsd:integer',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("1.0", DF.namedNode(`${XSD}decimal`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1.0"^^xsd:decimal .
`,
      },
    },

    // =====================================================
    // LANGUAGE TAG TESTS
    // =====================================================

    // Language tag en vs en-US
    {
      name: 'language_tag_en_vs_en_us',
      description: 'Language tag "en" encoded differently than "en-US"',
      category: 'language-tag',
      query: `
PREFIX : <http://example.org/>
SELECT ?s WHERE { ?s :label "hello"@en }
`,
      validData: `
@prefix : <http://example.org/> .
:x :label "hello"@en .
`,
      expectedError: 'Object term encoding mismatch: language tag @en vs @en-US',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}label`),
          object: DF.literal("hello", "en-US"),  // Wrong language tag!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :label "hello"@en-US .
`,
      },
    },

    // Language tagged vs plain literal
    {
      name: 'language_tag_vs_plain',
      description: 'Language-tagged literal encoded differently than plain literal',
      category: 'language-tag',
      query: `
PREFIX : <http://example.org/>
SELECT ?s WHERE { ?s :label "hello"@en }
`,
      validData: `
@prefix : <http://example.org/> .
:x :label "hello"@en .
`,
      expectedError: 'Object term encoding mismatch: language tag @en vs plain',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}label`),
          object: DF.literal("hello"),  // No language tag!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :label "hello" .
`,
      },
    },

    // Language tag case sensitivity (en vs EN)
    {
      name: 'language_tag_case_sensitivity',
      description: 'Language tags are case-insensitive in RDF, but our encoding may differ',
      category: 'language-tag',
      query: `
PREFIX : <http://example.org/>
SELECT ?s WHERE { ?s :label "hello"@en }
`,
      validData: `
@prefix : <http://example.org/> .
:x :label "hello"@en .
`,
      expectedError: 'Object term encoding mismatch: language tag @en vs @EN (case difference)',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}label`),
          object: DF.literal("hello", "EN"),  // Different case!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :label "hello"@EN .
`,
      },
    },

    // Language tagged vs xsd:string
    {
      name: 'language_tag_vs_xsd_string',
      description: 'Language-tagged literal vs xsd:string typed literal',
      category: 'language-tag',
      query: `
PREFIX : <http://example.org/>
SELECT ?s WHERE { ?s :label "hello"@en }
`,
      validData: `
@prefix : <http://example.org/> .
:x :label "hello"@en .
`,
      expectedError: 'Object term encoding mismatch: language tag @en vs xsd:string',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}label`),
          object: DF.literal("hello", DF.namedNode(`${XSD}string`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :label "hello"^^xsd:string .
`,
      },
    },

    // =====================================================
    // BOOLEAN ENCODING TESTS
    // =====================================================

    // Boolean true vs integer 1
    {
      name: 'boolean_true_vs_integer_1',
      description: 'Boolean true encoded differently than integer 1',
      category: 'boolean-encoding',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :flag true }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :flag "true"^^xsd:boolean .
`,
      expectedError: 'Object term encoding mismatch: boolean true vs integer 1',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}flag`),
          object: DF.literal("1", DF.namedNode(`${XSD}integer`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :flag "1"^^xsd:integer .
`,
      },
    },

    // Boolean false vs integer 0
    {
      name: 'boolean_false_vs_integer_0',
      description: 'Boolean false encoded differently than integer 0',
      category: 'boolean-encoding',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :flag false }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :flag "false"^^xsd:boolean .
`,
      expectedError: 'Object term encoding mismatch: boolean false vs integer 0',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}flag`),
          object: DF.literal("0", DF.namedNode(`${XSD}integer`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :flag "0"^^xsd:integer .
`,
      },
    },

    // Boolean "1" vs "true" (both valid boolean representations)
    {
      name: 'boolean_1_vs_true',
      description: 'Both "1" and "true" are valid booleans - test encoding consistency',
      category: 'boolean-encoding',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :flag "true"^^xsd:boolean }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :flag "true"^^xsd:boolean .
`,
      expectedError: 'Object term encoding: boolean canonical form test',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}flag`),
          object: DF.literal("1", DF.namedNode(`${XSD}boolean`)),  // "1" is also valid boolean!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :flag "1"^^xsd:boolean .
`,
      },
    },

    // =====================================================
    // IRI vs LITERAL CONFUSION TESTS
    // =====================================================

    // IRI vs literal with same text
    {
      name: 'iri_vs_literal_same_text',
      description: 'IRI should be encoded differently than literal with same text',
      category: 'iri-literal-confusion',
      query: `
PREFIX : <http://example.org/>
SELECT ?s WHERE { ?s :link <http://example.org/target> }
`,
      validData: `
@prefix : <http://example.org/> .
:x :link <http://example.org/target> .
`,
      expectedError: 'Object term encoding mismatch: IRI vs literal with same text',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}link`),
          object: DF.literal("http://example.org/target"),  // Literal, not IRI!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :link "http://example.org/target" .
`,
      },
    },

    // rdf:type object must be IRI vs literal
    {
      name: 'rdf_type_iri_vs_literal',
      description: 'rdf:type object should be IRI, not literal',
      category: 'iri-literal-confusion',
      query: `
PREFIX : <http://example.org/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?s WHERE { ?s rdf:type :Person }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
:x rdf:type :Person .
`,
      expectedError: 'Object term encoding mismatch: type IRI vs literal',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${RDF}type`),
          object: DF.literal("http://example.org/Person"),  // Literal, not IRI!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
:x rdf:type "http://example.org/Person" .
`,
      },
    },

    // =====================================================
    // DATETIME ENCODING TESTS
    // =====================================================

    // DateTime vs integer (both get numeric encoding)
    {
      name: 'datetime_vs_integer',
      description: 'DateTime should not match an integer with same numeric value',
      category: 'datetime-encoding',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :timestamp "2024-01-01T00:00:00Z"^^xsd:dateTime }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :timestamp "2024-01-01T00:00:00Z"^^xsd:dateTime .
`,
      expectedError: 'Object term encoding mismatch: dateTime vs integer',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}timestamp`),
          // 1704067200000 is epoch ms for 2024-01-01T00:00:00Z
          object: DF.literal("1704067200000", DF.namedNode(`${XSD}integer`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :timestamp "1704067200000"^^xsd:integer .
`,
      },
    },

    // DateTime string vs typed dateTime
    {
      name: 'datetime_string_vs_typed',
      description: 'Plain string should not match typed dateTime',
      category: 'datetime-encoding',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :timestamp "2024-01-01T00:00:00Z"^^xsd:dateTime }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :timestamp "2024-01-01T00:00:00Z"^^xsd:dateTime .
`,
      expectedError: 'Object term encoding mismatch: string vs xsd:dateTime',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}timestamp`),
          object: DF.literal("2024-01-01T00:00:00Z"),  // Plain string, not typed!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :timestamp "2024-01-01T00:00:00Z" .
`,
      },
    },

    // xsd:date vs xsd:dateTime
    {
      name: 'date_vs_datetime',
      description: 'xsd:date should be encoded differently than xsd:dateTime',
      category: 'datetime-encoding',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :created "2024-01-01"^^xsd:date }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :created "2024-01-01"^^xsd:date .
`,
      expectedError: 'Object term encoding mismatch: xsd:date vs xsd:dateTime',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}created`),
          object: DF.literal("2024-01-01T00:00:00Z", DF.namedNode(`${XSD}dateTime`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :created "2024-01-01T00:00:00Z"^^xsd:dateTime .
`,
      },
    },

    // =====================================================
    // DATATYPE MISMATCH TESTS
    // =====================================================

    // Custom datatype vs plain string
    {
      name: 'custom_type_vs_plain_string',
      description: 'Custom typed literal should differ from plain string',
      category: 'datatype-mismatch',
      query: `
PREFIX : <http://example.org/>
SELECT ?s WHERE { ?s :data "test"^^:myType }
`,
      validData: `
@prefix : <http://example.org/> .
:x :data "test"^^:myType .
`,
      expectedError: 'Object term encoding mismatch: custom datatype vs plain string',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}data`),
          object: DF.literal("test"),  // Plain string, no custom type!
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :data "test" .
`,
      },
    },

    // xsd:string vs plain literal
    {
      name: 'xsd_string_vs_plain',
      description: 'Explicit xsd:string vs implicit string (should be equivalent in RDF 1.1)',
      category: 'datatype-mismatch',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :name "test"^^xsd:string }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :name "test"^^xsd:string .
`,
      expectedError: 'Object term encoding: xsd:string vs plain (should match in RDF 1.1)',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}name`),
          object: DF.literal("test"),  // Plain literal (implicit xsd:string in RDF 1.1)
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :name "test" .
`,
      },
    },

    // Float vs double
    {
      name: 'float_vs_double',
      description: 'xsd:float should be encoded differently than xsd:double',
      category: 'datatype-mismatch',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :value "1.5"^^xsd:float }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1.5"^^xsd:float .
`,
      expectedError: 'Object term encoding mismatch: xsd:float vs xsd:double',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("1.5", DF.namedNode(`${XSD}double`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1.5"^^xsd:double .
`,
      },
    },

    // Integer with leading zeros
    {
      name: 'integer_leading_zeros',
      description: 'Integer "01" should encode the same as "1" (canonical form)',
      category: 'datatype-mismatch',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :value "1"^^xsd:integer }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      expectedError: 'Object term encoding: integer canonical form test',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("01", DF.namedNode(`${XSD}integer`)),  // Leading zero
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "01"^^xsd:integer .
`,
      },
    },

    // Negative integer forms
    {
      name: 'negative_integer_forms',
      description: 'Negative integer -1 vs "-1"^^xsd:integer',
      category: 'datatype-mismatch',
      query: `
PREFIX : <http://example.org/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE { ?s :value -1 }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "-1"^^xsd:integer .
`,
      expectedError: 'Object term encoding: negative integer form',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          // Test with string representation
          object: DF.literal("-1"),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
        },
        dataForSigning: `
@prefix : <http://example.org/> .
:x :value "-1" .
`,
      },
    },

    // =====================================================
    // VARIABLE BINDING TESTS - Testing variable value mismatches
    // =====================================================

    // Wrong subject binding
    {
      name: 'wrong_subject_binding',
      description: 'Variable ?s bound to wrong subject should fail',
      category: 'type-confusion',
      query: `
PREFIX : <http://example.org/>
SELECT ?s WHERE { ?s :value 1 }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      expectedError: 'Variable binding mismatch: claimed ?s does not match BGP subject',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),  // Triple has :x
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("1", DF.namedNode(`${XSD}integer`)),
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}y`),  // But claim it's :y!
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      },
    },

    // Wrong object binding (variable in object position)
    {
      name: 'wrong_object_binding',
      description: 'Variable ?o bound to wrong object should fail',
      category: 'type-confusion',
      query: `
PREFIX : <http://example.org/>
SELECT ?s ?o WHERE { ?s :value ?o }
`,
      validData: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      expectedError: 'Variable binding mismatch: claimed ?o does not match BGP object',
      invalidInputs: {
        triple: {
          subject: DF.namedNode(`${EX}x`),
          predicate: DF.namedNode(`${EX}value`),
          object: DF.literal("1", DF.namedNode(`${XSD}integer`)),  // Triple has 1
          graph: DF.defaultGraph(),
        },
        variables: {
          s: DF.namedNode(`${EX}x`),
          o: DF.literal("2", DF.namedNode(`${XSD}integer`)),  // But claim it's 2!
        },
        dataForSigning: `
@prefix : <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:x :value "1"^^xsd:integer .
`,
      },
    },
  ];
}
