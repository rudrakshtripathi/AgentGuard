# Prompt-injection classifier comparison

## Grouped nested-CV results

| Model | ROC-AUC | PR-AUC | Recall @ 1% FPR | Recall @ 5% FPR | F1 | Brier | Log loss | Accuracy |
|---|---|---|---|---|---|---|---|---|
| word_char_logistic | 0.999 ± 0.001 | 0.999 ± 0.001 | 0.933 ± 0.080 | 0.995 ± 0.006 | 0.985 ± 0.007 | 0.014 ± 0.004 | 0.058 ± 0.011 | 0.986 ± 0.006 |
| word_char_linear_svc | 0.999 ± 0.001 | 0.998 ± 0.001 | 0.926 ± 0.095 | 0.995 ± 0.006 | 0.981 ± 0.009 | 0.015 ± 0.006 | 0.058 ± 0.020 | 0.981 ± 0.009 |
| word_linear_svc | 0.999 ± 0.001 | 0.999 ± 0.001 | 0.916 ± 0.085 | 0.995 ± 0.010 | 0.973 ± 0.012 | 0.021 ± 0.009 | 0.079 ± 0.034 | 0.973 ± 0.012 |
| word_logistic | 0.999 ± 0.002 | 0.998 ± 0.002 | 0.942 ± 0.068 | 0.988 ± 0.020 | 0.971 ± 0.015 | 0.026 ± 0.025 | 0.111 ± 0.100 | 0.972 ± 0.014 |
| complement_nb | 0.998 ± 0.002 | 0.998 ± 0.003 | 0.942 ± 0.075 | 0.981 ± 0.024 | 0.941 ± 0.018 | 0.048 ± 0.012 | 0.171 ± 0.034 | 0.940 ± 0.020 |

Selected model: **word_logistic**. word_char_logistic was within one baseline standard deviation (0.020) of the baseline's recall at 5% FPR, so the simpler word-only LogisticRegression remains selected.

Nested tuning used only grouped training folds. Model order is determined by mean recall at 5% FPR, then mean Brier score, then simplicity.

## Existing Rego operating points

These use selected-model grouped out-of-fold probabilities only (score 0–100). The current policy reviews final scores in [30,70), blocks final scores at 70, and separately blocks injection scores at 80.

| Operating point | Precision | Recall | Confusion matrix (TN, FP, FN, TP) |
|---|---:|---:|---|
| Review band [30, 70) | 0.507 | 0.079 | 440, 33, 396, 34 |
| Final score block ≥ 70 | 0.990 | 0.919 | 469, 4, 35, 395 |
| Injection score block ≥ 80 | 0.994 | 0.826 | 471, 2, 75, 355 |

## Challenge-set report (finalists only)

The challenge set was evaluated once after model selection and did not influence tuning, selection, or threshold decisions.

| Finalist | Accuracy | Precision | Recall | Confusion matrix (TN, FP, FN, TP) |
|---|---:|---:|---:|---|
| word_logistic | 0.967 | 0.938 | 1.000 | 14, 1, 0, 15 |
| word_char_logistic | 0.967 | 0.938 | 1.000 | 14, 1, 0, 15 |

## Limitations

The corpus remains small and partly template-generated. Grouped CV reduces template leakage but cannot represent the diversity of production inputs. The 30-example hand-written challenge set is a small final check, not a reliable population estimate.
