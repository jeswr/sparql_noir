# Proof Specification

This document specifies the proof types, derivation rules, and proof structure for zero-knowledge SPARQL query proofs.

## 1. Overview

A ZK-SPARQL proof demonstrates that query results are correct without revealing the underlying signed datasets beyond what is explicitly disclosed.

### 1.1 Proof Components

A complete proof consists of:

1. **Signature Proofs (PoKS)**: Knowledge of valid signatures on dataset roots
2. **Inclusion Proofs**: Merkle path proofs for triple membership  
3. **Constraint Proofs**: Filter and equality constraint satisfaction
4. **Bound Proofs (PoNB)**: Numeric range assertions (optional)

### 1.2 Proof Goals

Given:
- Query $Q$ with projected variables $V$
- Signed datasets $\{D_1, \ldots, D_n\}$ with public keys $\{pk_1, \ldots, pk_n\}$
- Solution mapping $\mu : V \to T$

Prove:
$$
\exists D'_1, \ldots, D'_n : \bigwedge_{i=1}^{n} \text{Verify}(pk_i, \text{root}(D'_i)) \land \mu \in \text{eval}(Q, D'_1 \cup \ldots \cup D'_n)
$$

Without revealing $D'_i$ beyond $\mu$ and structural parameters.

---

## 2. Proof of Knowledge of Signature (PoKS)

### 2.1 Definition

A PoKS demonstrates knowledge of a valid signature over a Merkle root without revealing the root value (unless disclosed).

**Statement:** "I know a signature $\sigma$ and root $r$ such that $\text{Verify}(pk, r, \sigma) = \text{true}$"

### 2.2 Circuit Representation

```noir
fn verify_poks(
    public_key: PubKey,      // Public input
    root: Field,             // Private input (witness)
    signature: Signature,    // Private input (witness)
) {
    assert(verify_signature(public_key, signature, root));
}
```

### 2.3 Derivation Rule

$$
\frac{
    \text{SignedDataset}(pk, r, \sigma) \quad \text{Verify}(pk, r, \sigma) = \text{true}
}{
    \text{PoKS}(pk)
}
$$

### 2.4 Multiple Datasets

For queries over multiple signed datasets:

$$
\text{PoKS}_{combined} = \bigwedge_{i=1}^{n} \text{PoKS}(pk_i)
$$

---

## 3. Merkle Inclusion Proof

### 3.1 Definition

Proves that an encoded triple is a leaf in a Merkle tree with a specific root.

**Statement:** "Triple $t$ is at position $i$ in a dataset with root $r$"

### 3.2 Circuit Representation

```noir
fn verify_inclusion(
    leaf: Field,                        // Encoded triple
    path: [Field; MERKLE_DEPTH],        // Sibling hashes
    directions: [u8; MERKLE_DEPTH - 1], // Path directions
    root: Field,                        // Expected root
) {
    let computed_root = compute_merkle_root(leaf, path, directions);
    assert(computed_root == root);
}

fn compute_merkle_root(
    leaf: Field,
    path: [Field; MERKLE_DEPTH],
    directions: [u8; MERKLE_DEPTH - 1],
) -> Field {
    let mut current = hash2([leaf, path[0]]);
    for i in 1..MERKLE_DEPTH {
        let (left, right) = if directions[i-1] == 0 {
            (current, path[i])
        } else {
            (path[i], current)
        };
        current = hash2([left, right]);
    }
    current
}
```

### 3.3 Derivation Rule

$$
\frac{
    \text{Enc}_Q(s, p, o, g) = leaf \quad \text{MerklePath}(leaf, path, dir) \quad \text{ComputeRoot}(leaf, path, dir) = r
}{
    \text{Inclusion}((s, p, o, g), r)
}
$$

---

## 4. Variable Binding Proof

### 4.1 Definition

Proves that a variable binding is consistent with a triple in the dataset.

**Statement:** "Variable $?x$ is bound to term $t$ which appears at position $j$ in triple $i$"

### 4.2 Circuit Representation

```noir
fn verify_binding(
    variable_value: Field,    // Encoded binding value
    triple: TripleInput,      // Triple from dataset
    position: u32,            // 0=subject, 1=predicate, 2=object
) {
    assert(variable_value == triple.terms[position]);
}
```

### 4.3 Derivation Rule

$$
\frac{
    \mu(?x) = t \quad \text{triple}[j] = t \quad \text{Inclusion}(\text{triple}, r)
}{
    \text{Binding}(?x, t, r)
}
$$

---

## 5. Equality Constraint Proof

### 5.1 Definition

Proves that two variable bindings refer to the same term (for JOIN unification and sameTerm filters).

**Statement:** "Variables $?x$ and $?y$ are bound to the same term"

### 5.2 Circuit Representation

```noir
fn verify_equality(
    binding_x: Field,  // Encoded binding for ?x
    binding_y: Field,  // Encoded binding for ?y
) {
    assert(binding_x == binding_y);
}
```

### 5.3 Derivation Rule

$$
\frac{
    \text{Binding}(?x, t_1, r_1) \quad \text{Binding}(?y, t_2, r_2) \quad t_1 = t_2
}{
    \text{Equality}(?x, ?y)
}
$$

---

## 6. Proof of Numeric Bounds (PoNB)

### 6.1 Definition

Proves that a numeric value satisfies a range constraint without revealing the exact value.

**Statement:** "The value of $?x$ satisfies $a \leq x \leq b$"

### 6.2 Supported Types

| Type | Encoding | Comparison |
|------|----------|------------|
| xsd:integer | Direct field value | Numeric |
| xsd:decimal | Scaled integer | Numeric |
| xsd:dateTime | Unix epoch ms | Numeric |
| xsd:date | Unix epoch ms (midnight) | Numeric |

### 6.3 Circuit Representation

```noir
fn verify_numeric_bound(
    value: Field,        // Hidden numeric value
    lower_bound: Field,  // Lower bound (may be public)
    upper_bound: Field,  // Upper bound (may be public)
) {
    // Convert to comparable integers
    let v = value as u64;
    let lo = lower_bound as u64;
    let hi = upper_bound as u64;
    
    assert(lo <= v);
    assert(v <= hi);
}
```

### 6.4 Derivation Rule

$$
\frac{
    \text{Binding}(?x, t, r) \quad \text{Enc}_{special}(t) = v \quad a \leq v \leq b
}{
    \text{PoNB}(?x, a, b)
}
$$

### 6.5 Comparison Operators

| SPARQL Filter | PoNB Constraint |
|---------------|-----------------|
| `?x < c` | $\text{PoNB}(?x, -\infty, c-1)$ |
| `?x <= c` | $\text{PoNB}(?x, -\infty, c)$ |
| `?x > c` | $\text{PoNB}(?x, c+1, +\infty)$ |
| `?x >= c` | $\text{PoNB}(?x, c, +\infty)$ |
| `?x = c` | $\text{PoNB}(?x, c, c)$ |
| `a < ?x < b` | $\text{PoNB}(?x, a+1, b-1)$ |

---

## 7. Filter Proof

### 7.1 Boolean Filter Composition

Complex filters are composed from primitive constraints:

| Filter | Proof Composition |
|--------|------------------|
| `f1 && f2` | $\text{Proof}(f_1) \land \text{Proof}(f_2)$ |
| `f1 \|\| f2` | $\text{Proof}(f_1) \lor \text{Proof}(f_2)$ |
| `!f` | $\neg\text{Proof}(f)$ |

### 7.2 Disjunction Handling

For `f1 || f2`, use branch indicators:

```noir
fn verify_disjunction(
    branch_1: bool,      // True if branch 1 taken
    branch_2: bool,      // True if branch 2 taken
    constraint_1: bool,  // f1 satisfied (if branch_1)
    constraint_2: bool,  // f2 satisfied (if branch_2)
) {
    assert(branch_1 || branch_2);  // At least one branch
    
    if branch_1 {
        assert(constraint_1);
    }
    if branch_2 {
        assert(constraint_2);
    }
}
```

### 7.3 Term Testing Filters

| Filter | Circuit Check |
|--------|---------------|
| `bound(?x)` | `is_bound[?x] == true` |
| `isIRI(?x)` | `term_type[?x] == 0` |
| `isBlank(?x)` | `term_type[?x] == 1` |
| `isLiteral(?x)` | `term_type[?x] == 2` |
| `sameTerm(?x, ?y)` | `enc(?x) == enc(?y)` |

---

## 8. Union Branch Proof

### 8.1 Definition

For UNION patterns, proves that at least one branch's constraints are satisfied.

### 8.2 Circuit Representation

```noir
fn verify_union(
    branch_indicators: [bool; N],  // Which branches are active
    branch_proofs: [BranchProof; N],  // Proof for each branch
) {
    // At least one branch must be active
    let mut any_active = false;
    for i in 0..N {
        any_active |= branch_indicators[i];
    }
    assert(any_active);
    
    // Active branches must have valid proofs
    for i in 0..N {
        if branch_indicators[i] {
            assert(branch_proofs[i].is_valid);
        }
    }
}
```

### 8.3 Derivation Rule

$$
\frac{
    b_1 \lor b_2 \lor \ldots \lor b_n \quad \bigwedge_{i : b_i} \text{Proof}(P_i)
}{
    \text{UnionProof}(P_1 \cup P_2 \cup \ldots \cup P_n)
}
$$

---

## 9. Optional Pattern Proof

### 9.1 Definition

For LEFT JOIN patterns, variables from the optional part may be unbound.

### 9.2 Circuit Representation

```noir
struct OptionalProof {
    is_matched: bool,                    // Did optional pattern match?
    binding_proofs: [BindingProof; M],   // Proofs if matched
}

fn verify_optional(
    required_proof: RequiredProof,   // Proof for required pattern
    optional_proof: OptionalProof,   // Proof for optional pattern
) {
    // Required pattern must always be satisfied
    assert(required_proof.is_valid);
    
    // If optional matched, its constraints must hold
    if optional_proof.is_matched {
        for proof in optional_proof.binding_proofs {
            assert(proof.is_valid);
        }
    }
}
```

### 9.3 Derivation Rule

$$
\frac{
    \text{Proof}(P_1) \quad (\text{matched} \implies \text{Proof}(P_2))
}{
    \text{OptionalProof}(P_1 \mathbin{\text{⟕}} P_2)
}
$$

---

## 10. Complete Proof Structure

### 10.1 Proof Object

```rust
pub struct Proof {
    /// Circuit proof (Noir/Barretenberg)
    pub circuit_proof: Vec<u8>,
    
    /// Verification key
    pub verification_key: Vec<u8>,
    
    /// Public inputs
    pub public_inputs: PublicInputs,
    
    /// Metadata for verification
    pub metadata: ProofMetadata,
}

pub struct PublicInputs {
    /// Public keys of dataset signers
    pub public_keys: Vec<PublicKey>,
    
    /// Query hash (commitment to query)
    pub query_hash: Field,
    
    /// Disclosed variable bindings (if any)
    pub disclosed_bindings: HashMap<String, Field>,
}

pub struct ProofMetadata {
    /// SPARQL query (for verifier reference)
    pub query: String,
    
    /// Configuration used
    pub config: ProofConfig,
    
    /// Circuit identifier
    pub circuit_id: String,
    
    /// Timestamp
    pub created_at: u64,
}
```

### 10.2 Verification Algorithm

```rust
pub fn verify(proof: &Proof) -> Result<VerificationResult> {
    // 1. Verify circuit proof
    let circuit_valid = barretenberg::verify(
        &proof.circuit_proof,
        &proof.verification_key,
        &proof.public_inputs.to_fields(),
    )?;
    
    if !circuit_valid {
        return Ok(VerificationResult::Invalid("Circuit proof failed"));
    }
    
    // 2. Verify disclosed bindings match public inputs
    for (var, value) in &proof.public_inputs.disclosed_bindings {
        // Check consistency with circuit outputs
    }
    
    // 3. Verify any post-circuit constraints
    // (e.g., filter constraints not checked in circuit)
    
    Ok(VerificationResult::Valid)
}
```

---

## 11. Proof Composition

### 11.1 Sequential Composition

For complex queries, proofs can be composed:

$$
\text{Proof}(Q_1 \bowtie Q_2) = \text{Proof}(Q_1) \otimes \text{Proof}(Q_2)
$$

Where $\otimes$ denotes proof composition with shared variable verification.

### 11.2 Future: Recursive Composition

For scalability (future work):
- Prove proofs are valid within a circuit
- Enables unbounded dataset aggregation
- Uses Noir's recursive verification capabilities

---

## 12. Security Properties

### 12.1 Soundness

A valid proof implies the existence of signed datasets satisfying the query:

$$
\text{Verify}(\text{proof}) = \text{true} \implies \exists D_1, \ldots, D_n : \mu \in \text{eval}(Q, \bigcup_i D_i)
$$

### 12.2 Zero-Knowledge

The proof reveals only:
1. Public keys of signers
2. The SPARQL query
3. Explicitly disclosed bindings
4. Architectural parameters

### 12.3 Completeness

For any valid solution, a proof can be constructed:

$$
\mu \in \text{eval}(Q, D) \land \text{Signed}(D) \implies \exists \text{proof} : \text{Verify}(\text{proof}) = \text{true}
$$

---

## 13. Implementation Notes

### 13.1 Circuit Generation

The Rust transformation generates Noir code:

```rust
// From transform/src/main.rs
fn generate_constraint_assertions(
    info: &ProjectInfo,
    bindings: &BTreeMap<String, CircomTerm>,
) -> String {
    let mut assertions = Vec::new();
    
    // PoKS: Signature verification
    assertions.push("assert(verify_signature(public_key, signature, root));");
    
    // Inclusion: Merkle proofs
    for (i, pattern) in info.out.input_patterns.iter().enumerate() {
        assertions.push(format!(
            "assert(verify_inclusion(bgp[{}], root));",
            i
        ));
    }
    
    // Bindings: Variable consistency
    for eq in &info.out.eqs {
        assertions.push(format!(
            "assert({} == {});",
            serialize_term(&eq.0, info, bindings),
            serialize_term(&eq.1, info, bindings),
        ));
    }
    
    // Filters: Constraint assertions
    for filter in &info.out.filters {
        assertions.push(filter_to_noir(filter, info, bindings));
    }
    
    assertions.join("\n")
}
```

### 13.2 Metadata Emission

Circuit metadata tracks proof structure:

```json
{
  "variables": ["?s", "?p", "?o"],
  "inputPatterns": [...],
  "optionalPatterns": [...],
  "unionBranches": null,
  "hiddenInputs": ["bound_lower", "bound_upper"],
  "pathPlans": [...]
}
```

---

## References

1. Groth16: On the Size of Pairing-based Non-interactive Arguments
2. PLONK: Permutations over Lagrange-bases for Oecumenical Noninteractive arguments of Knowledge
3. Barretenberg: Aztec's proving system
4. Noir: Domain Specific Language for ZK Proofs
