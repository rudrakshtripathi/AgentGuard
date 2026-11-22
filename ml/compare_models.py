"""Nested grouped-CV model selection and export for AgentGuard's injection classifier."""
from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from pathlib import Path

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

import numpy as np
import pandas as pd
import sklearn
from scipy.special import expit, logit
from sklearn.calibration import CalibratedClassifierCV
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.naive_bayes import ComplementNB
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
TRAIN_CSV = ROOT / "data" / "injection_dataset.csv"
EXTRA_CSV = ROOT / "data" / "hand_written_extra.csv"
CHALLENGE_CSV = ROOT / "data" / "challenge_set.csv"
OUT_MD = ROOT / "model" / "comparison.md"
OUT_JSON = ROOT / "model" / "comparison.json"
MODEL_OUT = REPO / "apps" / "api" / "models" / "injection-model.json"
PARITY_OUT = REPO / "apps" / "api" / "models" / "injection-parity.json"
METRICS_OUT = ROOT / "model" / "metrics.json"
TOKEN_PATTERN = r"(?u)\b\w\w+\b"
SEED = 20261122
OUTER_FOLDS = 5
INNER_FOLDS = 3
C_GRID = [1.0, 10.0, 100.0]
CLASS_WEIGHTS = [None, "balanced"]
BASELINE = "word_logistic"
CANDIDATES = [BASELINE, "word_linear_svc", "word_char_logistic", "word_char_linear_svc", "complement_nb"]
SIMPLICITY = {BASELINE: 0, "complement_nb": 1, "word_linear_svc": 2, "word_char_logistic": 3, "word_char_linear_svc": 4}


def load_data() -> tuple[np.ndarray, np.ndarray, np.ndarray, pd.DataFrame]:
    train = pd.read_csv(TRAIN_CSV)
    extra = pd.read_csv(EXTRA_CSV)
    rows = pd.concat([train, extra], ignore_index=True)
    required = {"text", "label", "group_id"}
    if not required.issubset(rows.columns):
        raise ValueError(f"training rows must include {sorted(required)}")
    if rows["group_id"].isna().any() or (rows["group_id"].astype(str).str.len() == 0).any():
        raise ValueError("every training row must have a non-empty group_id")
    if rows.groupby("group_id")["label"].nunique().max() != 1:
        raise ValueError("group IDs must not combine different labels")
    texts = rows["text"].astype(str).to_numpy()
    labels = rows["label"].astype(int).to_numpy()
    groups = rows["group_id"].astype(str).to_numpy()
    return texts, labels, groups, rows


def make_vectorizer(kind: str) -> TfidfVectorizer:
    if kind == "word":
        return TfidfVectorizer(
            analyzer="word", lowercase=True, ngram_range=(1, 2), token_pattern=TOKEN_PATTERN,
            min_df=1, max_features=8000, norm="l2", sublinear_tf=False, smooth_idf=True,
        )
    if kind == "char":
        return TfidfVectorizer(
            analyzer="char_wb", lowercase=True, ngram_range=(3, 5),
            min_df=1, max_features=30000, norm="l2", sublinear_tf=True, smooth_idf=True,
        )
    raise ValueError(kind)


def make_feature_union(name: str) -> FeatureUnion:
    if name.startswith("word_char_"):
        return FeatureUnion([("word", make_vectorizer("word")), ("char", make_vectorizer("char"))])
    return FeatureUnion([("word", make_vectorizer("word"))])


def grouped_splits(labels: np.ndarray, groups: np.ndarray, folds: int, seed: int) -> list[tuple[np.ndarray, np.ndarray]]:
    splitter = StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=seed)
    splits = list(splitter.split(np.zeros(len(labels)), labels, groups))
    for train_idx, valid_idx in splits:
        if set(groups[train_idx]) & set(groups[valid_idx]):
            raise AssertionError("group leakage across a CV fold")
        if len(np.unique(labels[train_idx])) < 2 or len(np.unique(labels[valid_idx])) < 2:
            raise ValueError("a grouped fold is missing a class")
    return splits


def make_classifier(name: str, params: dict):
    if name.endswith("logistic"):
        return LogisticRegression(
            C=float(params["C"]), class_weight=params["class_weight"], max_iter=5000,
            random_state=SEED, solver="lbfgs",
        )
    if name.endswith("linear_svc"):
        return LinearSVC(C=float(params["C"]), class_weight=params["class_weight"], random_state=SEED, dual="auto", max_iter=20000)
    if name == "complement_nb":
        return ComplementNB(alpha=1.0)
    raise ValueError(name)


def predict_from_matrix(name: str, params: dict, train_matrix, train_y: np.ndarray,
                        train_groups: np.ndarray, valid_matrix) -> np.ndarray:
    if name.endswith("linear_svc"):
        calibration_folds = grouped_splits(train_y, train_groups, INNER_FOLDS, SEED + 17)
        model = CalibratedClassifierCV(
            estimator=make_classifier(name, params), method="sigmoid", ensemble=False, cv=calibration_folds,
        ).fit(train_matrix, train_y)
        return model.predict_proba(valid_matrix)[:, 1]
    model = make_classifier(name, params).fit(train_matrix, train_y)
    return model.predict_proba(valid_matrix)[:, 1]


def fit_predict(name: str, params: dict, train_texts: np.ndarray, train_y: np.ndarray,
                train_groups: np.ndarray, predict_texts: np.ndarray) -> np.ndarray:
    features = make_feature_union(name)
    train_matrix = features.fit_transform(train_texts)
    predict_matrix = features.transform(predict_texts)
    return predict_from_matrix(name, params, train_matrix, train_y, train_groups, predict_matrix)


def recall_at_fpr(y: np.ndarray, probabilities: np.ndarray, limit: float) -> float:
    fpr, tpr, _ = roc_curve(y, probabilities)
    return float(np.max(tpr[fpr <= limit]))


def fold_metrics(y: np.ndarray, probabilities: np.ndarray) -> dict[str, float]:
    predictions = probabilities >= 0.5
    return {
        "roc_auc": float(roc_auc_score(y, probabilities)),
        "pr_auc": float(average_precision_score(y, probabilities)),
        "recall_at_1pct_fpr": recall_at_fpr(y, probabilities, 0.01),
        "recall_at_5pct_fpr": recall_at_fpr(y, probabilities, 0.05),
        "f1": float(f1_score(y, predictions, zero_division=0)),
        "brier": float(brier_score_loss(y, probabilities)),
        "log_loss": float(log_loss(y, np.clip(probabilities, 1e-15, 1 - 1e-15), labels=[0, 1])),
        "accuracy": float(accuracy_score(y, predictions)),
    }


def tune_params(name: str, texts: np.ndarray, labels: np.ndarray, groups: np.ndarray, seed: int) -> tuple[dict, dict]:
    if name == "complement_nb":
        oof = np.zeros(len(labels), dtype=float)
        for train_idx, valid_idx in grouped_splits(labels, groups, INNER_FOLDS, seed):
            oof[valid_idx] = fit_predict(
                name, {"alpha": 1.0}, texts[train_idx], labels[train_idx], groups[train_idx], texts[valid_idx],
            )
        return {"alpha": 1.0}, {
            "recall_at_5pct_fpr": recall_at_fpr(labels, oof, 0.05),
            "brier": float(brier_score_loss(labels, oof)),
        }
    params_grid = [
        {"C": c, "class_weight": weight}
        for c in C_GRID for weight in CLASS_WEIGHTS
    ]
    splits = grouped_splits(labels, groups, INNER_FOLDS, seed)
    prepared = []
    for train_idx, valid_idx in splits:
        features = make_feature_union(name)
        train_matrix = features.fit_transform(texts[train_idx])
        valid_matrix = features.transform(texts[valid_idx])
        prepared.append((train_idx, valid_idx, train_matrix, valid_matrix))
    scores = []
    for params in params_grid:
        oof = np.zeros(len(labels), dtype=float)
        for train_idx, valid_idx, train_matrix, valid_matrix in prepared:
            oof[valid_idx] = predict_from_matrix(
                name, params, train_matrix, labels[train_idx], groups[train_idx], valid_matrix,
            )
        scores.append((recall_at_fpr(labels, oof, 0.05), -brier_score_loss(labels, oof), -float(params["C"]), params))
    best = max(scores, key=lambda item: item[:3])
    return best[3], {"recall_at_5pct_fpr": best[0], "brier": -best[1]}


def metric_summary(values: list[float]) -> dict[str, float]:
    return {"mean": float(np.mean(values)), "std": float(np.std(values, ddof=1)) if len(values) > 1 else 0.0}


def pipeline_for_export(name: str, params: dict, texts: np.ndarray, labels: np.ndarray,
                         groups: np.ndarray):
    features = make_feature_union(name)
    matrix = features.fit_transform(texts)
    classifier = make_classifier(name, params).fit(matrix, labels)
    if name.endswith("logistic"):
        coef = classifier.coef_[0].astype(float)
        intercept = float(classifier.intercept_[0])
        reference = classifier.predict_proba(matrix)[:, 1]
        predict = lambda xs: classifier.predict_proba(features.transform(xs))[:, 1]
    elif name.endswith("linear_svc"):
        base = classifier
        base_scores = base.decision_function(matrix)
        cal_splits = grouped_splits(labels, groups, OUTER_FOLDS, SEED + 101)
        calibrated = CalibratedClassifierCV(
            estimator=Pipeline([("features", make_feature_union(name)), ("classifier", make_classifier(name, params))]),
            method="sigmoid", ensemble=False, cv=cal_splits,
        ).fit(texts, labels)
        reference = calibrated.predict_proba(texts)[:, 1]
        usable = (reference > 1e-12) & (reference < 1 - 1e-12)
        if usable.sum() < 3:
            raise RuntimeError("not enough non-saturated sigmoid calibration probabilities to export the SVC")
        z = logit(reference[usable])
        design = np.column_stack([base_scores[usable], np.ones(usable.sum())])
        fitted, *_ = np.linalg.lstsq(design, z, rcond=None)
        coef = base.coef_[0].astype(float) * fitted[0]
        intercept = float(base.intercept_[0] * fitted[0] + fitted[1])
        predict = lambda xs: calibrated.predict_proba(xs)[:, 1]
    elif name == "complement_nb":
        coef = (classifier.feature_log_prob_[1] - classifier.feature_log_prob_[0]).astype(float)
        intercept = 0.0
        reference = classifier.predict_proba(matrix)[:, 1]
        predict = lambda xs: classifier.predict_proba(features.transform(xs))[:, 1]
    else:
        raise ValueError(name)

    exported = expit(matrix @ coef + intercept)
    error = float(np.max(np.abs(exported - reference)))
    if error > 1e-9:
        raise RuntimeError(f"exported probability differs from sklearn predict_proba by {error:.3g} on training rows")
    return features, coef, intercept, predict, reference, error


def export_vectorizer(vectorizer: TfidfVectorizer) -> dict:
    return {
        "lowercase": True,
        "ngram_range": list(vectorizer.ngram_range),
        "norm": "l2",
        "sublinear_tf": bool(vectorizer.sublinear_tf),
        "vocabulary": {term: int(index) for term, index in sorted(vectorizer.vocabulary_.items())},
        "idf": [float(value) for value in vectorizer.idf_],
    }


def build_model_json(name: str, sklearn_version: str, features: FeatureUnion, coef: np.ndarray,
                     intercept: float, cv_results: dict, challenge_results: dict) -> dict:
    parts = {part_name: vectorizer for part_name, vectorizer in features.transformer_list}
    char_model = "char" in parts
    word_model = export_vectorizer(parts["word"])
    if not char_model:
        word_model["token_pattern"] = TOKEN_PATTERN
    return {
        "format": "agentguard-tfidf-linear-v2" if char_model else "agentguard-tfidf-logreg-v1",
        "sklearn_version": sklearn_version,
        "vectorizer": ({"word": word_model, "char_wb": export_vectorizer(parts["char"])}
                        if char_model else word_model),
        "classifier": {"coef": [float(v) for v in coef], "intercept": float(intercept)},
        "metrics": {"grouped_cv": cv_results, "challenge_set": challenge_results},
    }


def eval_threshold(y: np.ndarray, probabilities: np.ndarray, threshold: float, upper: float | None = None) -> dict:
    pred = probabilities >= threshold
    if upper is not None:
        pred &= probabilities < upper
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "threshold": threshold,
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def challenge_metrics(y: np.ndarray, probabilities: np.ndarray) -> dict:
    pred = probabilities >= 0.5
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "n": int(len(y)),
        "accuracy": float(accuracy_score(y, pred)),
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def fmt_metric(summary: dict) -> str:
    return f"{summary['mean']:.3f} ± {summary['std']:.3f}"


def main() -> None:
    texts, labels, groups, rows = load_data()
    outer = grouped_splits(labels, groups, OUTER_FOLDS, SEED)
    fold_values: dict[str, dict[str, list[float]]] = {
        name: defaultdict(list) for name in CANDIDATES
    }
    oof: dict[str, np.ndarray] = {name: np.zeros(len(labels), dtype=float) for name in CANDIDATES}
    chosen_params: dict[str, list[dict]] = {name: [] for name in CANDIDATES}

    for fold_number, (train_idx, valid_idx) in enumerate(outer, start=1):
        x_train, y_train, g_train = texts[train_idx], labels[train_idx], groups[train_idx]
        x_valid, y_valid = texts[valid_idx], labels[valid_idx]
        print(f"outer fold {fold_number}/{OUTER_FOLDS}: train={len(train_idx)} validation={len(valid_idx)} groups={len(set(g_train))}")
        for name in CANDIDATES:
            params, tune = tune_params(name, x_train, y_train, g_train, SEED + fold_number * 101)
            chosen_params[name].append(params)
            probabilities = fit_predict(name, params, x_train, y_train, g_train, x_valid)
            oof[name][valid_idx] = probabilities
            for metric, value in fold_metrics(y_valid, probabilities).items():
                fold_values[name][metric].append(value)
            print(f"  {name}: {params}; inner recall@5%FPR={tune['recall_at_5pct_fpr']:.3f}")

    results = {
        name: {metric: metric_summary(values) for metric, values in metrics.items()}
        for name, metrics in fold_values.items()
    }
    ordered = sorted(
        CANDIDATES,
        key=lambda name: (
            -results[name]["recall_at_5pct_fpr"]["mean"],
            results[name]["brier"]["mean"],
            SIMPLICITY[name],
        ),
    )
    best_cv = ordered[0]
    baseline_mean = results[BASELINE]["recall_at_5pct_fpr"]["mean"]
    baseline_std = results[BASELINE]["recall_at_5pct_fpr"]["std"]
    if best_cv != BASELINE and results[best_cv]["recall_at_5pct_fpr"]["mean"] - baseline_mean <= baseline_std:
        selected = BASELINE
        selection_note = (
            f"{best_cv} was within one baseline standard deviation ({baseline_std:.3f}) of the baseline's "
            "recall at 5% FPR, so the simpler word-only LogisticRegression remains selected."
        )
    else:
        selected = best_cv
        selection_note = f"{selected} had the best mean recall at 5% FPR and was selected by the stated rule."

    finalists = list(dict.fromkeys([BASELINE, best_cv]))
    final_params = {}
    for name in CANDIDATES:
        counts = Counter(tuple(sorted(param.items())) for param in chosen_params[name])
        common = counts.most_common()
        if name == "complement_nb":
            final_params[name] = {"alpha": 1.0}
        else:
            top_count = common[0][1]
            tied = [dict(items) for items, count in common if count == top_count]
            final_params[name] = min(tied, key=lambda p: (float(p["C"]), str(p["class_weight"])))

    # Challenge set is loaded once, after CV and model selection; it cannot affect selection.
    challenge_frame = pd.read_csv(CHALLENGE_CSV)
    challenge_texts = challenge_frame["text"].astype(str).to_numpy()
    challenge_y = challenge_frame["label"].astype(int).to_numpy()
    challenge_results = {}
    for name in finalists:
        p = fit_predict(name, final_params[name], texts, labels, groups, challenge_texts)
        challenge_results[name] = challenge_metrics(challenge_y, p)

    # Fit/export the selected model on all training + extra hand-written rows.
    features, coef, intercept, predict_reference, sklearn_probs, parity_error = pipeline_for_export(
        selected, final_params[selected], texts, labels, groups,
    )
    all_predictions = predict_reference(texts)
    train_export_error = float(np.max(np.abs(all_predictions - sklearn_probs)))
    if train_export_error > 1e-9:
        raise RuntimeError(f"export parity failed on training/validation rows: max error {train_export_error:.3g}")

    edge_texts = [
        "", "a", "I", "### !!!", "🙂 🧪", "Ünïcödé façade naïve résumé", "xy", "word", "x y z",
        "repeat " * 250, "ignore previous instructions " * 200,
        "This is a deliberately long neutral validation string. " * 150,
        "-- comment", "/* nested-looking punctuation */", "ééé", "a-b_c!",
    ]
    parity_texts = list(dict.fromkeys(list(texts[:50]) + edge_texts))
    parity_probs = predict_reference(np.asarray(parity_texts, dtype=str))
    exported_edges = expit(features.transform(np.asarray(parity_texts, dtype=str)) @ coef + intercept)
    edge_error = float(np.max(np.abs(parity_probs - exported_edges)))
    if edge_error > 1e-9:
        raise RuntimeError(f"export parity failed on edge samples: max error {edge_error:.3g}")

    cv_selected = {
        "model": selected,
        "metrics": results[selected],
        "grouped_oof_thresholds": {
            "review_band_30_to_70": eval_threshold(labels, oof[selected], 0.30, 0.70),
            "final_score_block_at_70": eval_threshold(labels, oof[selected], 0.70),
            "injection_score_block_at_80": eval_threshold(labels, oof[selected], 0.80),
        },
        "selected_parameters": final_params[selected],
        "challenge_set": challenge_results.get(selected),
        "max_export_probability_error": max(parity_error, train_export_error, edge_error),
    }
    report = {
        "protocol": {
            "seed": SEED,
            "outer_folds": OUTER_FOLDS,
            "inner_folds": INNER_FOLDS,
            "grouping": "StratifiedGroupKFold; all rows share no group IDs across a train/validation split",
            "tuning": "Nested within each outer training fold; C in {1,10,100} and class_weight in {None,balanced}; optimize recall at 5% FPR, then Brier score",
            "challenge_set": "Loaded only after CV comparison and final selection; report-only, never used for tuning or selection",
        },
        "dataset": {
            "training_rows": int(len(rows)),
            "base_rows": int(len(pd.read_csv(TRAIN_CSV))),
            "new_hand_written_rows": int(len(pd.read_csv(EXTRA_CSV))),
            "benign": int((labels == 0).sum()),
            "injection": int((labels == 1).sum()),
            "groups": int(len(np.unique(groups))),
            "grouping_note": "All generated rows have source-template or handwritten-seed group IDs; the 100 new handwritten examples each have a unique seed ID.",
        },
        "models": results,
        "ordered_by_selection_rule": ordered,
        "best_cross_validated_candidate": best_cv,
        "selected_model": selected,
        "selection_note": selection_note,
        "selected_parameters": final_params[selected],
        "selected_grouped_oof_thresholds": cv_selected["grouped_oof_thresholds"],
        "challenge_set_finalists": challenge_results,
        "export": {
            "max_probability_error": cv_selected["max_export_probability_error"],
            "verified_rows": int(len(texts) + len(parity_texts)),
            "format": "v2" if "char" in selected else "v1",
        },
        "sklearn_version": sklearn.__version__,
    }

    model_json = build_model_json(selected, sklearn.__version__, features, coef, intercept, cv_selected, challenge_results.get(selected))
    MODEL_OUT.write_text(json.dumps(model_json, separators=(",", ":")), encoding="utf8")
    PARITY_OUT.write_text(json.dumps([
        {"text": text, "probability": float(probability)} for text, probability in zip(parity_texts, parity_probs)
    ], ensure_ascii=False, indent=1), encoding="utf8")
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(report, indent=2), encoding="utf8")
    METRICS_OUT.write_text(json.dumps(report, indent=2), encoding="utf8")

    headers = ["Model", "ROC-AUC", "PR-AUC", "Recall @ 1% FPR", "Recall @ 5% FPR", "F1", "Brier", "Log loss", "Accuracy"]
    lines = ["# Prompt-injection classifier comparison", "", "## Grouped nested-CV results", "", "| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for name in ordered:
        lines.append("| " + " | ".join([name] + [fmt_metric(results[name][metric]) for metric in (
            "roc_auc", "pr_auc", "recall_at_1pct_fpr", "recall_at_5pct_fpr", "f1", "brier", "log_loss", "accuracy",
        )]) + " |")
    lines += ["", f"Selected model: **{selected}**. {selection_note}", "", "Nested tuning used only grouped training folds. Model order is determined by mean recall at 5% FPR, then mean Brier score, then simplicity.", "", "## Existing Rego operating points", "", "These use selected-model grouped out-of-fold probabilities only (score 0–100). The current policy reviews final scores in [30,70), blocks final scores at 70, and separately blocks injection scores at 80.", "", "| Operating point | Precision | Recall | Confusion matrix (TN, FP, FN, TP) |", "|---|---:|---:|---|"]
    for key, label in (("review_band_30_to_70", "Review band [30, 70)"), ("final_score_block_at_70", "Final score block ≥ 70"), ("injection_score_block_at_80", "Injection score block ≥ 80")):
        item = cv_selected["grouped_oof_thresholds"][key]
        cm = item["confusion_matrix"]
        lines.append(f"| {label} | {item['precision']:.3f} | {item['recall']:.3f} | {cm['tn']}, {cm['fp']}, {cm['fn']}, {cm['tp']} |")
    lines += ["", "## Challenge-set report (finalists only)", "", "The challenge set was evaluated once after model selection and did not influence tuning, selection, or threshold decisions.", "", "| Finalist | Accuracy | Precision | Recall | Confusion matrix (TN, FP, FN, TP) |", "|---|---:|---:|---:|---|"]
    for name, item in challenge_results.items():
        cm = item["confusion_matrix"]
        lines.append(f"| {name} | {item['accuracy']:.3f} | {item['precision']:.3f} | {item['recall']:.3f} | {cm['tn']}, {cm['fp']}, {cm['fn']}, {cm['tp']} |")
    lines += ["", "## Limitations", "", "The corpus remains small and partly template-generated. Grouped CV reduces template leakage but cannot represent the diversity of production inputs. The 30-example hand-written challenge set is a small final check, not a reliable population estimate.", ""]
    OUT_MD.write_text("\n".join(lines), encoding="utf8")
    print("\n".join(lines))
    print(f"\nexported {selected}; max sklearn/export probability error={cv_selected['max_export_probability_error']:.3g}")


if __name__ == "__main__":
    main()
