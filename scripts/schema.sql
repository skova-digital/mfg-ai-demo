-- 検査記録AI デモ: D1 スキーマ
DROP TABLE IF EXISTS inspection_records;
CREATE TABLE inspection_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  product_code TEXT NOT NULL,
  lot_no TEXT NOT NULL,
  process TEXT NOT NULL CHECK (process IN ('cutting','grinding','assembly','final')),
  inspector TEXT NOT NULL,
  qty_inspected INTEGER NOT NULL CHECK (qty_inspected > 0),
  qty_defect INTEGER NOT NULL DEFAULT 0 CHECK (qty_defect >= 0),
  defect_type TEXT CHECK (defect_type IN ('dimension','scratch','burr','stain','other') OR defect_type IS NULL),
  measurement REAL,
  spec_lower REAL,
  spec_upper REAL,
  judgement TEXT NOT NULL CHECK (judgement IN ('pass','fail','recheck')),
  note TEXT,
  source_type TEXT NOT NULL DEFAULT 'text' CHECK (source_type IN ('text','image','sample','seed')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_records_date ON inspection_records(recorded_at);
CREATE INDEX IF NOT EXISTS idx_records_product ON inspection_records(product_code, process);
