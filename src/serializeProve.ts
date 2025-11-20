import { type InputMap, type InputValue } from "@noir-lang/noirc_abi";

/**
 * Converts an InputMap to a Prover.toml file format
 * Based on https://noir-lang.org/docs/dev/getting_started/project_breakdown
 */
function serializeProve(inputs: InputMap): string {
  const lines: string[] = [];
  
  for (const [key, value] of Object.entries(inputs)) {
    lines.push(serializeInputValue(key, value));
  }
  
  return lines.join('\n');
}

/**
 * Serializes a single input value to TOML format
 */
function serializeInputValue(key: string, value: InputValue): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    // Handle primitive values (Field types)
    return `${key} = "${value}"`;
  } else if (Array.isArray(value)) {
    // Handle arrays
    return serializeArray(key, value);
  } else if (typeof value === 'object' && value !== null) {
    // Handle objects/structs
    return serializeObject(key, value);
  } else {
    throw new Error(`Unsupported input value type for key ${key}: ${typeof value}`);
  }
}

/**
 * Serializes an array to TOML format
 */
function serializeArray(key: string, array: InputValue[]): string {
  const lines: string[] = [];
  
  // Check if this is an array of objects (structs)
  if (array.length > 0 && typeof array[0] === 'object' && !Array.isArray(array[0])) {
    // Array of structs - use TOML array of tables syntax
    for (let i = 0; i < array.length; i++) {
      const obj = array[i] as InputMap;
      lines.push(`[[${key}]] # ${key}[${i}]`);
      for (const [objKey, objValue] of Object.entries(obj)) {
        if (typeof objValue === 'string' || typeof objValue === 'number' || typeof objValue === 'boolean') {
          lines.push(`${objKey} = "${objValue}"`);
        } else if (Array.isArray(objValue)) {
          // Handle nested arrays within structs
          const arrayStr = objValue.map(v => `"${v}"`).join(', ');
          lines.push(`${objKey} = [${arrayStr}]`);
        } else {
          throw new Error(`Unsupported nested object type in array for key ${key}.${objKey}`);
        }
      }
      lines.push(''); // Empty line between array elements
    }
    return lines.join('\n').trim();
  } else {
    // Simple array or array of primitives
    const arrayStr = array.map(v => {
      if (Array.isArray(v)) {
        // Nested array
        const nestedArrayStr = v.map(nv => `"${nv}"`).join(', ');
        return `[${nestedArrayStr}]`;
      } else {
        return `"${v}"`;
      }
    }).join(', ');
    return `${key} = [${arrayStr}]`;
  }
}

/**
 * Serializes an object/struct to TOML format
 */
function serializeObject(key: string, obj: InputMap): string {
  const lines: string[] = [];
  
  // For simple objects, we can use dot notation or table format
  // Using table format for clarity
  lines.push(`[${key}]`);
  
  for (const [objKey, objValue] of Object.entries(obj)) {
    if (typeof objValue === 'string' || typeof objValue === 'number' || typeof objValue === 'boolean') {
      lines.push(`${objKey} = "${objValue}"`);
    } else if (Array.isArray(objValue)) {
      const arrayStr = objValue.map(v => `"${v}"`).join(', ');
      lines.push(`${objKey} = [${arrayStr}]`);
    } else if (typeof objValue === 'object' && objValue !== null) {
      // Nested object - use nested table format
      lines.push(`[${key}.${objKey}]`);
      for (const [nestedKey, nestedValue] of Object.entries(objValue as InputMap)) {
        if (typeof nestedValue === 'string' || typeof nestedValue === 'number' || typeof nestedValue === 'boolean') {
          lines.push(`${nestedKey} = "${nestedValue}"`);
        } else if (Array.isArray(nestedValue)) {
          const nestedArrayStr = nestedValue.map(v => `"${v}"`).join(', ');
          lines.push(`${nestedKey} = [${nestedArrayStr}]`);
        } else if (typeof nestedValue === 'object' && nestedValue !== null) {
          // Handle deeper nesting
          lines.push(`[${key}.${objKey}.${nestedKey}]`);
          for (const [deepKey, deepValue] of Object.entries(nestedValue as InputMap)) {
            lines.push(`${deepKey} = "${deepValue}"`);
          }
        }
      }
    }
  }
  
  return lines.join('\n');
}

export { serializeProve };
