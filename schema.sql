CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 phone TEXT UNIQUE,
 email TEXT,
 password_hash TEXT,
 role TEXT NOT NULL CHECK (role IN ('admin','delivery','customer')),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS customers (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 name TEXT NOT NULL,
 phone TEXT NOT NULL,
 email TEXT,
 milk_type TEXT NOT NULL CHECK (milk_type IN ('Cow Milk','Buffalo Milk')),
 daily_quantity NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (daily_quantity >= 0),
 price_per_litre NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (price_per_litre >= 0),
 latitude DOUBLE PRECISION,
 longitude DOUBLE PRECISION,
 gps_address TEXT,
 delivery_person_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 group_name TEXT DEFAULT 'Default',
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS deliveries (
 id BIGSERIAL PRIMARY KEY,
 customer_id BIGINT NOT NULL REFERENCES customers(id),
 delivery_date DATE NOT NULL,
 shift TEXT NOT NULL CHECK (shift IN ('Morning','Evening')),
 quantity NUMERIC(8,2) NOT NULL DEFAULT 0,
 amount NUMERIC(10,2) NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Delivered','Missed')),
 delivered_at TIMESTAMPTZ,
 delivered_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 notes TEXT,
 UNIQUE(customer_id, delivery_date, shift)
);
CREATE TABLE IF NOT EXISTS payments (
 id BIGSERIAL PRIMARY KEY,
 customer_id BIGINT NOT NULL REFERENCES customers(id),
 amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
 method TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Paid',
 razorpay_order_id TEXT,
 razorpay_payment_id TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS leaves (
 id BIGSERIAL PRIMARY KEY,
 customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 start_date DATE NOT NULL,
 end_date DATE NOT NULL,
 note TEXT,
 CHECK (end_date >= start_date)
);
CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 category TEXT DEFAULT 'Milk',
 unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
 active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS expenses (
 id BIGSERIAL PRIMARY KEY,
 category TEXT NOT NULL,
 description TEXT,
 amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
 expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
 id BIGSERIAL PRIMARY KEY,
 customer_id BIGINT REFERENCES customers(id),
 amount NUMERIC(10,2) NOT NULL,
 razorpay_order_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'created',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(delivery_date, shift);
CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON deliveries(customer_id, delivery_date);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id, created_at);
