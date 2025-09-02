import { createHash } from "crypto";
import { iriToField } from "./FIELD_MODULUS.js";

// Real witness data generator for SPARQL path proofs
export interface RealTriple {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface MerklePath {
  path: string[];
  directions: number[];
}

// Generate a realistic Merkle path for a triple
export function generateMerklePath(triple: RealTriple, depth: number = 11): MerklePath {
  // In a real implementation, this would query the actual Merkle tree
  // For now, we'll generate a deterministic path based on the triple hash
  const tripleHash = createHash('sha256')
    .update(`${triple.subject}${triple.predicate}${triple.object}`)
    .digest('hex');
  
  const path: string[] = [];
  const directions: number[] = [];
  
  for (let i = 0; i < depth; i++) {
    // Generate deterministic path elements as numeric strings
    const pathElement = createHash('sha256')
      .update(`${tripleHash}${i}`)
      .digest('hex')
      .slice(0, 16); // Use first 16 chars as hex
    
    // Convert hex to decimal string for Noir
    const decimalValue = BigInt('0x' + pathElement).toString();
    path.push(decimalValue);
    
    if (i < depth - 1) {
      // Generate direction (0 = left, 1 = right)
      directions.push(parseInt(tripleHash[i % 64] || '0', 16) % 2);
    }
  }
  
  return { path, directions };
}

// Convert real triple to circuit witness format
export function tripleToWitness(triple: RealTriple): any {
  const merklePath = generateMerklePath(triple);
  
  return {
    terms: [
      iriToField(triple.subject),
      iriToField(triple.predicate), 
      iriToField(triple.object),
      triple.graph ? iriToField(triple.graph) : "0"
    ],
    path: merklePath.path,
    directions: merklePath.directions
  };
}

// Generate realistic test data for different path types
export const testData = {
  knows: {
    triple: {
      subject: "http://example.org/alice",
      predicate: "http://example.org/knows",
      object: "http://example.org/bob"
    },
    startNode: iriToField("http://example.org/alice"),
    endNode: iriToField("http://example.org/bob")
  },
  
  worksAt: {
    triple: {
      subject: "http://example.org/bob", 
      predicate: "http://example.org/worksAt",
      object: "http://example.org/company"
    },
    startNode: iriToField("http://example.org/bob"),
    endNode: iriToField("http://example.org/company")
  },
  
  // For sequence paths (knows -> worksAt)
  sequence: {
    triple: {
      subject: "http://example.org/alice",
      predicate: "http://example.org/knows", // First step
      object: "http://example.org/bob"
    },
    startNode: iriToField("http://example.org/alice"),
    endNode: iriToField("http://example.org/company") // Final destination
  }
};

// Generate witness for a specific test case
export function generateTestWitness(testCase: keyof typeof testData) {
  const data = testData[testCase];
  return {
    triple: tripleToWitness(data.triple),
    s: data.startNode,
    o: data.endNode
  };
}
