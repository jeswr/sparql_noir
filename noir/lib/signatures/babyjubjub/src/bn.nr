// use dep::bignum::BigNum;
// use dep::bignum::fields::ed25519Fq::ED25519_Fq as Fq;

// // Check that (x1 * x2) + x3 equals `expected`
// fn bn(x1: Fq, x2: Fq, x3: Fq, expected: Fq) {
//     // Step 1: calculate res = (x1 * x2) + x3 in unconstrained functions
//     let res = x1.__mul(x2).__add(x3);

//     // Step 2: Constrain (x1 * x2) + x3 - res == 0 mod 2^255-19
//     // (until now we have value res, but "unchecked")

//     // `evaluate_quadratic_expression` takes:
//     // (1) x1, `false` sign flag
//     // (2) x2, `false` sign flag
//     // (3)
//     //  - x3, `false` sign flag
//     //  - res, `true` sign flag
//     // Combines to: (x1 * x2) + x3 + (-res)
//     BigNum::evaluate_quadratic_expression(
//         [[x1]],
//         [[false]],
//         [[x2]],
//         [[false]],
//         [x3, res],
//         [false, true],
//     );

//     // Step 3: check res equals `expected`
//     assert(res == expected); // Equality operation on BigNums
// }

// #[test]
// fn test_bn() {
//   bn(Fq::from_u64(1), Fq::from_u64(2), Fq::from_u64(3), Fq::from_u64(4));
// }
