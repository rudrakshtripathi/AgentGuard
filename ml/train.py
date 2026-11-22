"""Retrain the classifier via nested grouped comparison and export the selected model."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_models import main


if __name__ == "__main__":
    main()
