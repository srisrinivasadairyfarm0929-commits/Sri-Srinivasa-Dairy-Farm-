require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false } : false
});
const port = Number(process.env.PORT || 3000);
const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000*60*60*12 }
}));
app.use(express.static(path.join(__dirname, 'public')));

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  // Creates a convenient first admin account. Change ADMIN_PIN before deployment.
  const phone = process.env.ADMIN_PHONE || 'admin';
  const exists = await pool.query("SELECT id FROM users WHERE phone=$1", [phone]);
  if (!exists.rowCount) {
    const hash = await bcrypt.hash(process.env.ADMIN_PIN || 'change-this-before-launch', 12);
    await pool.query("INSERT INTO users(name,phone,password_hash,role) VALUES($1,$2,$3,'admin')",
      [process.env.ADMIN_NAME || 'Farm Admin', phone, hash]);
  }
}
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
function requireAuth(req,res,next) {
  if (!req.session.user) return res.status(401).json({error:'Please sign in first.'});
  next();
}
function requireAdmin(req,res,next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({error:'Admin access required.'});
  next();
}
function customerScope(req, customerId) {
  return req.session.user.role === 'admin' ||
    (req.session.user.role === 'customer' && Number(req.session.user.customer_id) === Number(customerId));
}
function todayISO() { return new Date().toISOString().slice(0,10); }

app.get('/api/health', (req,res) => res.json({ok:true, app:'Sri Srinivasa Dairy Farm Manager'}));
app.get('/api/session', (req,res) => res.json({user:req.session.user || null, razorpayReady:!!razorpay}));

app.post('/api/login', asyncRoute(async(req,res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({error:'Enter username and password/PIN.'});
  const result = await pool.query(
    `SELECT u.id,u.name,u.phone,u.password_hash,u.role,c.id AS customer_id
     FROM users u LEFT JOIN customers c ON c.user_id=u.id
     WHERE (u.phone=$1 OR u.email=$1) AND u.active=TRUE`, [String(username).trim()]);
  const user = result.rows[0];
  if (!user || !user.password_hash || !(await bcrypt.compare(String(pin), user.password_hash)))
    return res.status(401).json({error:'Invalid login details.'});
  req.session.regenerate(err => {
    if (err) return res.status(500).json({error:'Could not start session.'});
    req.session.user = {id:user.id,name:user.name,phone:user.phone,role:user.role,customer_id:user.customer_id};
    req.session.save(() => res.json({user:req.session.user}));
  });
}));
app.post('/api/logout', (req,res) => req.session.destroy(() => res.json({ok:true})));

app.get('/api/dashboard', requireAuth, asyncRoute(async(req,res) => {
  const date = String(req.query.date || todayISO());
  const [stats, dues, sales, staff] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE status='Delivered')::int AS completed,
      COUNT(*) FILTER(WHERE status='Pending')::int AS left,
      COUNT(*) FILTER(WHERE status='Missed')::int AS missed
      FROM deliveries WHERE delivery_date=$1`, [date]),
    pool.query(`SELECT COALESCE(SUM(GREATEST(billed.paid_due,0)),0)::numeric AS dues FROM (
      SELECT c.id, COALESCE((SELECT SUM(d.amount) FROM deliveries d WHERE d.customer_id=c.id AND d.status='Delivered'),0)
      - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id=c.id AND p.status='Paid'),0) AS paid_due
      FROM customers c WHERE c.active=TRUE) billed`),
    pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS sales FROM deliveries WHERE delivery_date=$1 AND status='Delivered'`,[date]),
    pool.query(`SELECT u.id,u.name,COUNT(d.id)::int AS deliveries,COALESCE(SUM(d.amount),0)::numeric AS sales
      FROM users u LEFT JOIN customers c ON c.delivery_person_id=u.id
      LEFT JOIN deliveries d ON d.customer_id=c.id AND d.delivery_date=$1
      WHERE u.role='delivery' GROUP BY u.id ORDER BY u.name`,[date])
  ]);
  res.json({date,stats:stats.rows[0],dues:dues.rows[0].dues,sales:sales.rows[0].sales,staff:staff.rows});
}));

app.get('/api/customers', requireAuth, asyncRoute(async(req,res) => {
  let sql = `SELECT c.*,u.name AS delivery_person_name,
    COALESCE((SELECT SUM(d.amount) FROM deliveries d WHERE d.customer_id=c.id AND d.status='Delivered'),0)
    - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id=c.id AND p.status='Paid'),0) AS amount_due
    FROM customers c LEFT JOIN users u ON u.id=c.delivery_person_id WHERE c.active=TRUE`;
  const args=[];
  if(req.session.user.role==='customer') { args.push(req.session.user.customer_id || 0); sql+=' AND c.id=$1'; }
  sql+=' ORDER BY c.name';
  res.json((await pool.query(sql,args)).rows);
}));
app.post('/api/customers', requireAdmin, asyncRoute(async(req,res) => {
  const {name,phone,email,milk_type,daily_quantity,price_per_litre,latitude,longitude,gps_address,group_name,delivery_person_id} = req.body;
  if(!name || !phone || !['Cow Milk','Buffalo Milk'].includes(milk_type)) return res.status(400).json({error:'Name, phone and valid milk type are required.'});
  const q=await pool.query(`INSERT INTO customers(name,phone,email,milk_type,daily_quantity,price_per_litre,latitude,longitude,gps_address,group_name,delivery_person_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [name.trim(),phone.trim(),email||null,milk_type,Number(daily_quantity||0),Number(price_per_litre||0),
     latitude===''||latitude==null?null:Number(latitude),longitude===''||longitude==null?null:Number(longitude),
     gps_address||null,group_name||'Default',delivery_person_id||null]);
  res.status(201).json(q.rows[0]);
}));
app.patch('/api/customers/:id', requireAdmin, asyncRoute(async(req,res) => {
  const fields=['name','phone','email','milk_type','daily_quantity','price_per_litre','latitude','longitude','gps_address','group_name','delivery_person_id'];
  const set=[],args=[];
  for(const f of fields) if(req.body[f]!==undefined){args.push(req.body[f]===''?null:req.body[f]);set.push(`${f}=$${args.length}`);}
  if(!set.length) return res.status(400).json({error:'No fields to update.'});
  args.push(req.params.id);
  const q=await pool.query(`UPDATE customers SET ${set.join(',')} WHERE id=$${args.length} AND active=TRUE RETURNING *`,args);
  if(!q.rowCount) return res.status(404).json({error:'Customer not found.'});
  res.json(q.rows[0]);
}));
app.delete('/api/customers/:id', requireAdmin, asyncRoute(async(req,res) => {
  const q=await pool.query('UPDATE customers SET active=FALSE WHERE id=$1 RETURNING id',[req.params.id]);
  if(!q.rowCount) return res.status(404).json({error:'Customer not found.'});
  res.json({ok:true});
}));

app.get('/api/deliveries', requireAuth, asyncRoute(async(req,res) => {
  const date=String(req.query.date||todayISO()), shift=String(req.query.shift||'Morning');
  if(!['Morning','Evening'].includes(shift)) return res.status(400).json({error:'Invalid shift.'});
  const args=[date,shift];
  let extra='';
  if(req.session.user.role==='customer'){args.push(req.session.user.customer_id||0);extra=` AND c.id=$3`;}
  if(req.session.user.role==='delivery'){args.push(req.session.user.id);extra=` AND c.delivery_person_id=$3`;}
  const q=await pool.query(`SELECT d.*,c.name,c.phone,c.milk_type,c.gps_address,c.latitude,c.longitude,c.group_name,
    c.daily_quantity,c.price_per_litre,COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id=c.id AND p.status='Paid'),0) AS paid_total,
    GREATEST(0,COALESCE((SELECT SUM(x.amount) FROM deliveries x WHERE x.customer_id=c.id AND x.status='Delivered'),0)
    - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id=c.id AND p.status='Paid'),0)) AS amount_due
    FROM deliveries d JOIN customers c ON c.id=d.customer_id
    WHERE d.delivery_date=$1 AND d.shift=$2 AND c.active=TRUE ${extra}
    ORDER BY c.group_name,c.name`,args);
  res.json(q.rows);
}));
app.post('/api/deliveries/generate', requireAdmin, asyncRoute(async(req,res) => {
  const date=String(req.body.date||todayISO()), shift=String(req.body.shift||'Morning');
  if(!['Morning','Evening'].includes(shift)) return res.status(400).json({error:'Invalid shift.'});
  const q=await pool.query(`INSERT INTO deliveries(customer_id,delivery_date,shift,quantity,amount,status)
    SELECT c.id,$1,$2,c.daily_quantity,c.daily_quantity*c.price_per_litre,'Pending'
    FROM customers c WHERE c.active=TRUE
    AND NOT EXISTS(SELECT 1 FROM leaves l WHERE l.customer_id=c.id AND l.start_date<=$1 AND l.end_date>=$1)
    ON CONFLICT(customer_id,delivery_date,shift) DO NOTHING RETURNING id`,[date,shift]);
  res.json({created:q.rowCount});
}));
app.patch('/api/deliveries/:id', requireAuth, asyncRoute(async(req,res) => {
  const {status}=req.body||{};
  if(!['Delivered','Missed','Pending'].includes(status)) return res.status(400).json({error:'Invalid delivery status.'});
  const q=await pool.query(`SELECT d.id,d.customer_id,c.delivery_person_id FROM deliveries d JOIN customers c ON c.id=d.customer_id WHERE d.id=$1`,[req.params.id]);
  if(!q.rowCount) return res.status(404).json({error:'Delivery not found.'});
  const d=q.rows[0];
  if(req.session.user.role==='customer') return res.status(403).json({error:'Customers cannot change delivery status.'});
  if(req.session.user.role==='delivery' && Number(d.delivery_person_id)!==Number(req.session.user.id)) return res.status(403).json({error:'Not assigned to this route.'});
  const up=await pool.query(`UPDATE deliveries SET status=$1,delivered_at=CASE WHEN $1='Delivered' THEN NOW() ELSE NULL END,
    delivered_by=$2 WHERE id=$3 RETURNING *`,[status,req.session.user.id,d.id]);
  res.json(up.rows[0]);
}));
app.post('/api/payments/cash', requireAuth, asyncRoute(async(req,res) => {
  const {customer_id,amount}=req.body;
  if(req.session.user.role==='customer' && !customerScope(req,customer_id)) return res.status(403).json({error:'Not your account.'});
  if(!customer_id || !(Number(amount)>0)) return res.status(400).json({error:'Customer and positive amount are required.'});
  const q=await pool.query('INSERT INTO payments(customer_id,amount,method,status) VALUES($1,$2,$3,$4) RETURNING *',
    [customer_id,Number(amount),'Cash','Paid']);
  res.status(201).json(q.rows[0]);
}));
app.get('/api/payments', requireAuth, asyncRoute(async(req,res) => {
  const args=[]; let where='';
  if(req.session.user.role==='customer'){args.push(req.session.user.customer_id||0);where='WHERE p.customer_id=$1';}
  const q=await pool.query(`SELECT p.*,c.name AS customer_name,c.phone FROM payments p JOIN customers c ON c.id=p.customer_id ${where} ORDER BY p.created_at DESC LIMIT 500`,args);
  res.json(q.rows);
}));

app.post('/api/leaves', requireAdmin, asyncRoute(async(req,res) => {
  const {customer_id,start_date,end_date,note}=req.body;
  if(!customer_id||!start_date||!end_date||end_date<start_date) return res.status(400).json({error:'Valid customer and dates required.'});
  const q=await pool.query('INSERT INTO leaves(customer_id,start_date,end_date,note) VALUES($1,$2,$3,$4) RETURNING *',[customer_id,start_date,end_date,note||null]);
  res.status(201).json(q.rows[0]);
}));
app.get('/api/leaves', requireAuth, asyncRoute(async(req,res) => {
 const q=await pool.query(`SELECT l.*,c.name FROM leaves l JOIN customers c ON c.id=l.customer_id ORDER BY start_date DESC LIMIT 500`);
 res.json(q.rows);
}));
app.get('/api/staff', requireAdmin, asyncRoute(async(req,res) => { res.json((await pool.query("SELECT id,name,phone FROM users WHERE role='delivery' AND active=TRUE ORDER BY name")).rows); }));
app.post('/api/staff', requireAdmin, asyncRoute(async(req,res) => {
 const {name,phone,pin}=req.body;
 if(!name||!phone||!pin||String(pin).length<6) return res.status(400).json({error:'Name, phone and a PIN of at least 6 characters are required.'});
 const hash=await bcrypt.hash(String(pin),12);
 const q=await pool.query("INSERT INTO users(name,phone,password_hash,role) VALUES($1,$2,$3,'delivery') RETURNING id,name,phone,role",[name,phone,hash]);
 res.status(201).json(q.rows[0]);
}));
app.get('/api/products', requireAuth, asyncRoute(async(req,res) => { res.json((await pool.query('SELECT * FROM products WHERE active=TRUE ORDER BY name')).rows); }));
app.post('/api/products', requireAdmin, asyncRoute(async(req,res) => {
 const {name,category,unit_price}=req.body;
 if(!name) return res.status(400).json({error:'Product name required.'});
 const q=await pool.query('INSERT INTO products(name,category,unit_price) VALUES($1,$2,$3) RETURNING *',[name,category||'Milk',Number(unit_price||0)]);
 res.status(201).json(q.rows[0]);
}));
app.get('/api/expenses', requireAdmin, asyncRoute(async(req,res) => { res.json((await pool.query('SELECT * FROM expenses ORDER BY expense_date DESC,id DESC LIMIT 500')).rows); }));
app.post('/api/expenses', requireAdmin, asyncRoute(async(req,res) => {
 const {category,description,amount,expense_date}=req.body;
 if(!category||!(Number(amount)>=0)) return res.status(400).json({error:'Category and valid amount required.'});
 const q=await pool.query('INSERT INTO expenses(category,description,amount,expense_date) VALUES($1,$2,$3,$4) RETURNING *',[category,description||null,Number(amount),expense_date||todayISO()]);
 res.status(201).json(q.rows[0]);
}));
app.get('/api/reports/monthly', requireAuth, asyncRoute(async(req,res) => {
 const month=String(req.query.month||todayISO().slice(0,7));
 if(!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({error:'Month must be YYYY-MM.'});
 const args=[month+'-01',month+'-01'];
 const q=await pool.query(`SELECT c.id,c.name,c.phone,c.milk_type,c.price_per_litre,
 COALESCE(SUM(d.quantity) FILTER(WHERE d.status='Delivered'),0)::numeric AS litres,
 COALESCE(SUM(d.amount) FILTER(WHERE d.status='Delivered'),0)::numeric AS billed,
 COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id=c.id AND to_char(p.created_at,'YYYY-MM')=$3 AND p.status='Paid'),0)::numeric AS paid
 FROM customers c LEFT JOIN deliveries d ON d.customer_id=c.id AND to_char(d.delivery_date,'YYYY-MM')=$3
 WHERE c.active=TRUE GROUP BY c.id ORDER BY c.name`,[month+'-01',month+'-01',month]);
 if(req.session.user.role==='customer') return res.json(q.rows.filter(x=>Number(x.id)===Number(req.session.user.customer_id)));
 res.json(q.rows);
}));

app.post('/api/create-order', requireAuth, asyncRoute(async(req,res) => {
 if(!razorpay) return res.status(503).json({error:'Razorpay is not configured. Add the two Razorpay secrets on your hosting provider.'});
 const customerId=Number(req.body.customer_id || req.session.user.customer_id);
 const amount=Number(req.body.amount);
 if(!customerId || !(amount>0) || !Number.isFinite(amount)) return res.status(400).json({error:'Customer and positive amount required.'});
 if(!customerScope(req,customerId)) return res.status(403).json({error:'Not your account.'});
 const c=await pool.query('SELECT id,name,phone,email FROM customers WHERE id=$1 AND active=TRUE',[customerId]);
 if(!c.rowCount) return res.status(404).json({error:'Customer not found.'});
 const order=await razorpay.orders.create({amount:Math.round(amount*100),currency:'INR',receipt:`dairy_${customerId}_${Date.now()}`,notes:{customer_id:String(customerId)}});
 await pool.query("INSERT INTO orders(customer_id,amount,razorpay_order_id,status) VALUES($1,$2,$3,'created')",[customerId,amount,order.id]);
 res.json({key_id:process.env.RAZORPAY_KEY_ID,order_id:order.id,amount:order.amount,currency:order.currency,customer:c.rows[0]});
}));
app.post('/api/razorpay/verify', requireAuth, asyncRoute(async(req,res) => {
 const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
 if(!razorpay || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({error:'Missing payment details or Razorpay is not configured.'});
 const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
 const a=Buffer.from(expected), b=Buffer.from(String(razorpay_signature));
 if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return res.status(400).json({error:'Payment signature verification failed.'});
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const order=await client.query("SELECT * FROM orders WHERE razorpay_order_id=$1 FOR UPDATE",[razorpay_order_id]);
  if(!order.rowCount) throw new Error('Order not found.');
  if(req.session.user.role==='customer' && Number(order.rows[0].customer_id)!==Number(req.session.user.customer_id)) throw new Error('Not your account.');
  if(order.rows[0].status!=='paid') {
   await client.query("INSERT INTO payments(customer_id,amount,method,status,razorpay_order_id,razorpay_payment_id) VALUES($1,$2,'Razorpay','Paid',$3,$4)",
     [order.rows[0].customer_id,order.rows[0].amount,razorpay_order_id,razorpay_payment_id]);
   await client.query("UPDATE orders SET status='paid' WHERE razorpay_order_id=$1",[razorpay_order_id]);
  }
  await client.query('COMMIT');
  res.json({ok:true,message:'Payment verified and recorded.'});
 } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next) => {
 console.error(err);
 if(err.code==='23505') return res.status(409).json({error:'A record with this phone or value already exists.'});
 res.status(500).json({error:process.env.NODE_ENV==='production'?'Server error. Please try again.':err.message});
});
initDb().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Sri Srinivasa Dairy Farm Manager listening on ${port}`)))
 .catch(err=>{console.error('Database startup failed:',err);process.exit(1);});
