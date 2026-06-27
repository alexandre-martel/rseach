"""
Mini XGBoost calibration test on Breast Cancer dataset.
Grid search over key hyperparams, with calibration curve evaluation.
"""

import json
import time
import numpy as np
from itertools import product
from sklearn.datasets import load_breast_cancer
from sklearn.model_selection import cross_val_predict, StratifiedKFold
from sklearn.calibration import calibration_curve
from sklearn.metrics import (
    accuracy_score, log_loss, brier_score_loss, roc_auc_score, f1_score
)
from xgboost import XGBClassifier


def run_trial(X, y, params, cv):
    clf = XGBClassifier(
        **params,
        eval_metric="logloss",
        use_label_encoder=False,
        verbosity=0,
        random_state=42,
    )
    y_prob = cross_val_predict(clf, X, y, cv=cv, method="predict_proba")[:, 1]
    y_pred = (y_prob >= 0.5).astype(int)

    fraction_pos, mean_predicted = calibration_curve(y, y_prob, n_bins=5)
    ece = np.mean(np.abs(fraction_pos - mean_predicted))

    return {
        "accuracy": round(accuracy_score(y, y_pred), 4),
        "f1": round(f1_score(y, y_pred), 4),
        "auc_roc": round(roc_auc_score(y, y_prob), 4),
        "log_loss": round(log_loss(y, y_prob), 4),
        "brier_score": round(brier_score_loss(y, y_prob), 4),
        "ece": round(ece, 4),
    }


def main():
    data = load_breast_cancer()
    X, y = data.data, data.target
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

    param_grid = {
        "max_depth": [3, 5],
        "learning_rate": [0.05, 0.1],
        "n_estimators": [50, 100],
        "subsample": [0.8],
    }

    keys = list(param_grid.keys())
    combos = list(product(*param_grid.values()))

    print(f"Dataset: Breast Cancer (n={len(y)}, features={X.shape[1]})")
    print(f"Trials: {len(combos)} combinations\n")
    print(f"{'#':<4} {'max_depth':<10} {'lr':<6} {'n_est':<6} {'acc':<7} {'f1':<7} {'auc':<7} {'brier':<7} {'ece':<7}")
    print("-" * 70)

    results = []
    best_brier = float("inf")

    for i, vals in enumerate(combos):
        params = dict(zip(keys, vals))
        t0 = time.time()
        metrics = run_trial(X, y, params, cv)
        elapsed = round(time.time() - t0, 1)

        tag = ""
        if metrics["brier_score"] < best_brier:
            best_brier = metrics["brier_score"]
            tag = " *best*"

        print(
            f"{i+1:<4} {params['max_depth']:<10} {params['learning_rate']:<6} "
            f"{params['n_estimators']:<6} {metrics['accuracy']:<7} {metrics['f1']:<7} "
            f"{metrics['auc_roc']:<7} {metrics['brier_score']:<7} {metrics['ece']:<7}"
            f"  ({elapsed}s){tag}"
        )

        results.append({"trial": i + 1, "params": params, "metrics": metrics, "time_s": elapsed})

    best = min(results, key=lambda r: r["metrics"]["brier_score"])
    print(f"\n{'='*70}")
    print(f"Best trial: #{best['trial']}")
    print(f"  Params:      {best['params']}")
    print(f"  Brier score: {best['metrics']['brier_score']}")
    print(f"  ECE:         {best['metrics']['ece']}")
    print(f"  AUC-ROC:     {best['metrics']['auc_roc']}")
    print(f"  Accuracy:    {best['metrics']['accuracy']}")

    with open("experiments/xgb_calibration_results.json", "w") as f:
        json.dump({"dataset": "breast_cancer", "best": best, "all_trials": results}, f, indent=2)
    print(f"\nResults saved to experiments/xgb_calibration_results.json")


if __name__ == "__main__":
    main()
