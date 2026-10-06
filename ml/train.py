"""Trains AgentGuard's prompt-injection classifier: TF-IDF + logistic regression.

  python ml/train.py        (or: npm run ml:train, which also regenerates the dataset)

Steps:
  1. Load ml/data/injection_dataset.csv, stratified 80/20 train/test split (seed 42).
  2. Fit TfidfVectorizer(word 1-2 grams) + LogisticRegression on the TRAIN split only.
  3. Report metrics on the held-out test split AND on the hand-written challenge set
     (ml/data/challenge_set.csv, never trained on) -> ml/model/metrics.json.
  4. Export the fitted model as plain JSON (vocabulary, idf, coefficients, intercept) to
     apps/api/models/injection-model.json. The Express API does inference in TypeScript
     from this file, so the gateway stays a single Node process (TRD §2).
  5. Export parity samples (sklearn probabilities) so the TypeScript implementation is
     tested against sklearn to 1e-9.

Demonstration-scale: a few hundred templated examples. Expect real-world accuracy to be
well below the test-split numbers; the challenge-set numbers are the more honest estimate.
"""

import csv
import json
from pathlib import Path

import numpy as np
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_score, recall_score
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
DATASET = ROOT / "data" / "injection_dataset.csv"
CHALLENGE = ROOT / "data" / "challenge_set.csv"
MODEL_OUT = REPO / "apps" / "api" / "models" / "injection-model.json"
PARITY_OUT = REPO / "apps" / "api" / "models" / "injection-parity.json"
METRICS_OUT = ROOT / "model" / "metrics.json"

TOKEN_PATTERN = r"(?u)\b\w\w+\b"  # sklearn default; mirrored in apps/api/src/scoring/injectionClassifier.ts


def load(path):
    with path.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    return [r["text"] for r in rows], np.array([int(r["label"]) for r in rows])


def metrics(y_true, y_pred):
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    return {
        "n": int(len(y_true)),
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 4),
        "precision": round(float(precision_score(y_true, y_pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, y_pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y_true, y_pred, zero_division=0)), 4),
        "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def main():
    texts, labels = load(DATASET)
    x_train, x_test, y_train, y_test = train_test_split(texts, labels, test_size=0.2, random_state=42, stratify=labels)

    vectorizer = TfidfVectorizer(
        lowercase=True, ngram_range=(1, 2), token_pattern=TOKEN_PATTERN, min_df=1, max_features=8000, norm="l2",
        sublinear_tf=False, smooth_idf=True,
    )
    clf = LogisticRegression(C=10.0, class_weight="balanced", max_iter=5000, random_state=42)
    clf.fit(vectorizer.fit_transform(x_train), y_train)

    def predict(xs):
        return clf.predict_proba(vectorizer.transform(xs))[:, 1]

    test_pred = (predict(x_test) >= 0.5).astype(int)
    c_texts, c_labels = load(CHALLENGE)
    c_prob = predict(c_texts)
    challenge_pred = (c_prob >= 0.5).astype(int)
    report = {
        "model": "TfidfVectorizer(word 1-2 grams) + LogisticRegression(C=10, balanced)",
        "sklearn_version": sklearn.__version__,
        "dataset": {"total": len(texts), "injection": int(labels.sum()), "benign": int(len(labels) - labels.sum())},
        "split": {"train": len(x_train), "test": len(x_test), "random_state": 42, "stratified": True},
        "test_split": metrics(y_test, test_pred),
        "challenge_set": metrics(c_labels, challenge_pred),
        "challenge_errors": [
            {"text": t, "label": int(y), "probability": round(float(p), 4)}
            for t, y, p in zip(c_texts, c_labels, c_prob)
            if int(p >= 0.5) != int(y)
        ],
    }

    vocab = {term: int(idx) for term, idx in vectorizer.vocabulary_.items()}
    model = {
        "format": "agentguard-tfidf-logreg-v1",
        "sklearn_version": sklearn.__version__,
        "vectorizer": {
            "lowercase": True,
            "token_pattern": TOKEN_PATTERN,
            "ngram_range": [1, 2],
            "norm": "l2",
            "sublinear_tf": False,
            "vocabulary": dict(sorted(vocab.items())),
            "idf": [float(v) for v in vectorizer.idf_],
        },
        "classifier": {"coef": [float(v) for v in clf.coef_[0]], "intercept": float(clf.intercept_[0])},
        "metrics": {"test_split": report["test_split"], "challenge_set": report["challenge_set"]},
    }
    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    MODEL_OUT.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")

    parity_texts = list(x_test[:40]) + c_texts + ["", "a", "Ünïcödé façade naïve résumé", "DROP TABLE users; -- ignore"]
    PARITY_OUT.write_text(
        json.dumps([{"text": t, "probability": float(p)} for t, p in zip(parity_texts, predict(parity_texts))], indent=1),
        encoding="utf-8",
    )
    METRICS_OUT.parent.mkdir(parents=True, exist_ok=True)
    METRICS_OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"features: {len(vocab)}")
    print(f"test split ({report['test_split']['n']}): {report['test_split']}")
    print(f"challenge set ({report['challenge_set']['n']}): {report['challenge_set']}")
    print(f"model  -> {MODEL_OUT.relative_to(REPO)}")
    print(f"parity -> {PARITY_OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
