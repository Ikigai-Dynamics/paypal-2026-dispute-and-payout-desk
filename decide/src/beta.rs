//! Beta distribution quantiles in plain Rust: regularized incomplete beta by continued
//! fraction, then bisection. Used for the 80% win-chance interval.

fn ln_gamma(x: f64) -> f64 {
    // Lanczos approximation (g = 7, n = 9)
    const C: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        return (std::f64::consts::PI / (std::f64::consts::PI * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let t = x + 7.5;
    let s: f64 = C[0] + (1..9).map(|i| C[i] / (x + i as f64)).sum::<f64>();
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + s.ln()
}

fn betacf(a: f64, b: f64, x: f64) -> f64 {
    const TINY: f64 = 1e-300;
    let (qab, qap, qam) = (a + b, a + 1.0, a - 1.0);
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < TINY {
        d = TINY;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..300 {
        let m = m as f64;
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < TINY {
            d = TINY;
        }
        c = 1.0 + aa / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        h *= d * c;
        let aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if d.abs() < TINY {
            d = TINY;
        }
        c = 1.0 + aa / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-14 {
            break;
        }
    }
    h
}

/// Regularized incomplete beta I_x(a, b), a and b > 0.
pub fn inc_beta(a: f64, b: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let bt = (ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln()).exp();
    if x < (a + 1.0) / (a + b + 2.0) {
        bt * betacf(a, b, x) / a
    } else {
        1.0 - bt * betacf(b, a, 1.0 - x) / b
    }
}

/// The x with I_x(a, b) = prob. A non-positive shape is a point mass at 0 or 1.
pub fn quantile(a: f64, b: f64, prob: f64) -> f64 {
    if a <= 1e-9 {
        return 0.0;
    }
    if b <= 1e-9 {
        return 1.0;
    }
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    for _ in 0..80 {
        let mid = 0.5 * (lo + hi);
        if inc_beta(a, b, mid) < prob {
            lo = mid
        } else {
            hi = mid
        }
    }
    0.5 * (lo + hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values() {
        // Beta(1,1) is uniform
        assert!((quantile(1.0, 1.0, 0.1) - 0.1).abs() < 1e-9);
        // Beta(2,2): I_x = 3x^2 - 2x^3, median 0.5
        assert!((quantile(2.0, 2.0, 0.5) - 0.5).abs() < 1e-9);
        assert!((inc_beta(2.0, 2.0, 0.25) - (3.0 * 0.0625 - 2.0 * 0.015625)).abs() < 1e-10);
        // Beta(2.2, 1.8): 10th/90th percentiles from a brute-force numeric integral of the density
        assert!((quantile(2.2, 1.8, 0.1) - 0.2405).abs() < 5e-4);
        assert!((quantile(2.2, 1.8, 0.9) - 0.8449).abs() < 5e-4);
    }
}
