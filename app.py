from flask import Flask, render_template, request, jsonify, g, redirect, url_for, flash
import sqlite3
import pandas as pd
import os
from datetime import datetime
from geopy.geocoders import Nominatim
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import numpy as np
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user

app = Flask(__name__)
app.config['SECRET_KEY'] = 'chave'
app.config['UPLOAD_FOLDER'] = 'uploads'
DATABASE = 'database.db'

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

class User(UserMixin):
    def __init__(self, id, username, password_hash):
        self.id = id
        self.username = username
        self.password = password_hash

@login_manager.user_loader
def load_user(user_id):
    db = get_db()
    user_data = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if user_data:
        return User(id=user_data['id'], username=user_data['username'], password_hash=user_data['password_hash'])
    return None

def get_db():
    db = getattr(g, '_database', None)
    if db is None:
        db = g._database = sqlite3.connect(DATABASE)
        db.row_factory = sqlite3.Row
    return db

@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, '_database', None)
    if db is not None:
        db.close()

def init_db():
    with app.app_context():
        db = get_db()
        db.execute('''
            CREATE TABLE IF NOT EXISTS routes (
                id INTEGER PRIMARY KEY, 
                name TEXT UNIQUE NOT NULL, 
                filename TEXT NOT NULL, 
                created_at DATETIME,
                supplier TEXT,
                product TEXT,
                route_info TEXT
            )
        ''')
        db.execute('CREATE TABLE IF NOT EXISTS geocache (id INTEGER PRIMARY KEY, lat REAL, lon REAL, address TEXT, UNIQUE(lat, lon))')
        db.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)')
        
        try:
            db.execute('ALTER TABLE routes ADD COLUMN supplier TEXT')
            db.execute('ALTER TABLE routes ADD COLUMN product TEXT')
            db.execute('ALTER TABLE routes ADD COLUMN route_info TEXT')
        except sqlite3.OperationalError:
            pass
            
        db.commit()
    if not os.path.exists(app.config['UPLOAD_FOLDER']):
        os.makedirs(app.config['UPLOAD_FOLDER'])


def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371
    lat1_rad, lon1_rad, lat2_rad, lon2_rad = map(np.radians, [lat1, lon1, lat2, lon2])
    dlon = lon2_rad - lon1_rad
    dlat = lat2_rad - lat1_rad
    a = np.sin(dlat / 2)**2 + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlon / 2)**2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return R * c

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated: return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        db = get_db()
        user_data = db.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
        if user_data and check_password_hash(user_data['password_hash'], password):
            user = User(id=user_data['id'], username=user_data['username'], password_hash=user_data['password_hash'])
            login_user(user, remember=True)
            return redirect(url_for('index'))
        else:
            flash('Usuário ou senha inválidos.', 'danger')
    return render_template('login.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated: return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        db = get_db()
        if db.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone():
            flash('Este nome de usuário já existe.', 'warning')
        else:
            hashed_password = generate_password_hash(password, method='pbkdf2:sha256')
            db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', (username, hashed_password))
            db.commit()
            flash('Conta criada com sucesso! Faça o login.', 'success')
            return redirect(url_for('login'))
    return render_template('register.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))


# Rotas da Aplicação Principal 
@app.route('/')
@login_required
def index():
    return render_template('index.html', current_user=current_user)

@app.route('/routes')
@login_required
def routes():
    db = get_db()
    rows = db.execute('SELECT id, name, created_at, supplier, product, route_info FROM routes ORDER BY created_at DESC').fetchall()
    return jsonify([dict(row) for row in rows])

@app.route('/route/<int:route_id>', methods=['GET'])
@login_required
def get_route_data(route_id):
    threshold = request.args.get('threshold', default=8.0, type=float)
    db = get_db()
    route = db.execute('SELECT * FROM routes WHERE id = ?', (route_id,)).fetchone()
    if not route: return jsonify({'error': 'Ensaio não encontrado'}), 404
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], route['filename'])
    try:
        df = pd.read_csv(filepath, names=['lat', 'lon', 'temp', 'vib', 'umid'])
        if df.empty: return jsonify({'error': 'Arquivo vazio.'}), 400

        total_distance = 0
        if len(df) > 1:
            distances = haversine_distance(df['lat'].iloc[:-1].values, df['lon'].iloc[:-1].values, df['lat'].iloc[1:].values, df['lon'].iloc[1:].values)
            total_distance = np.sum(distances)
        
        severe_impacts = df[df['vib'] > threshold].shape[0]
        max_vibration = df['vib'].max()
        
        # Retornando os dados do ensaio junto com os dados do gráfico
        route_details = dict(route)

        return jsonify({
            'details': route_details,
            'labels': df.index.tolist(),
            'datasets': {'temperatura': df['temp'].tolist(), 'vibracao': df['vib'].tolist(), 'umidade': df['umid'].tolist(), 'coordenadas': df[['lat', 'lon']].values.tolist()},
            'kpis': {'distance': round(total_distance, 2), 'impacts': severe_impacts, 'max_vibration': round(max_vibration, 2)}
        })
    except Exception as e:
        return jsonify({'error': f'Erro ao ler arquivo: {e}'}), 500

@app.route('/compare', methods=['GET'])
@login_required
def compare_routes():
    route_ids_str = request.args.get('ids')
    threshold = request.args.get('threshold', default=8.0, type=float)
    if not route_ids_str: return jsonify({'error': 'Nenhum ID fornecido'}), 400
    
    route_ids = [int(id) for id in route_ids_str.split(',')]
    response_data = {'labels': None, 'datasets': [], 'all_coords': []}
    labels = None
    db = get_db()

    for route_id in route_ids:
        route = db.execute('SELECT * FROM routes WHERE id = ?', (route_id,)).fetchone()
        if not route: continue

        filepath = os.path.join(app.config['UPLOAD_FOLDER'], route['filename'])
        try:
            df = pd.read_csv(filepath, names=['lat', 'lon', 'temp', 'vib', 'umid'])
            if df.empty: continue

            if labels is None or len(df.index) > len(labels):
                labels = df.index.tolist()
            
            total_distance = 0
            if len(df) > 1:
                distances = haversine_distance(df['lat'].iloc[:-1].values, df['lon'].iloc[:-1].values, df['lat'].iloc[1:].values, df['lon'].iloc[1:].values)
                total_distance = np.sum(distances)
            severe_impacts = df[df['vib'] > threshold].shape[0]
            max_vibration = df['vib'].max()

            response_data['datasets'].append({
                'name': route['name'],
                'temperatura': df['temp'].tolist(), 'vibracao': df['vib'].tolist(), 'umidade': df['umid'].tolist(),
                'kpis': {'distance': round(total_distance, 2), 'impacts': severe_impacts, 'max_vibration': round(max_vibration, 2)}
            })
            response_data['all_coords'].append(df[['lat', 'lon']].values.tolist())
        except Exception:
            continue
    
    response_data['labels'] = labels
    return jsonify(response_data)

# Outras Rotas (upload, delete, geocode)
@app.route('/route', methods=['POST'])
@login_required
def upload_route():
    name = request.form.get('name')
    supplier = request.form.get('supplier')
    product = request.form.get('product')
    route_info = request.form.get('route_info')
    file = request.files.get('file')

    if not all([name, supplier, product, route_info, file, file.filename]):
        return jsonify({'error': 'Todos os campos e o arquivo são obrigatórios'}), 400
        
    safe_filename = secure_filename(file.filename)
    filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{safe_filename}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)
    db = get_db()
    try:
        db.execute('''
            INSERT INTO routes (name, filename, created_at, supplier, product, route_info) 
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (name, filename, datetime.now(), supplier, product, route_info))
        db.commit()
    except sqlite3.IntegrityError:
        os.remove(filepath) 
        return jsonify({'error': 'Já existe um ensaio com este nome.'}), 400
    return jsonify({'success': True})


@app.route('/route/<int:route_id>', methods=['DELETE'])
@login_required
def delete_route(route_id):
    db = get_db()
    route = db.execute('SELECT filename FROM routes WHERE id=?', (route_id,)).fetchone()
    if route and route['filename']:
        try: os.remove(os.path.join(app.config['UPLOAD_FOLDER'], route['filename']))
        except OSError: pass
    db.execute('DELETE FROM routes WHERE id=?', (route_id,))
    db.commit()
    return jsonify({'success': True})

@app.route('/reverse_geocode')
@login_required
def reverse_geocode():
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    if lat is None or lon is None: return jsonify({'error': 'lat/lon obrigatórios'}), 400
    db = get_db()
    row = db.execute('SELECT address FROM geocache WHERE lat=? AND lon=?', (lat, lon)).fetchone()
    if row: return jsonify({'address': row['address']})
    geolocator = Nominatim(user_agent="tcc_datalogger_app/1.0", timeout=10)
    try:
        location = geolocator.reverse((lat, lon), language='pt', exactly_one=True)
        address = location.address if location else "Endereço não encontrado"
    except Exception as e:
        address = f"Não foi possível obter o endereço: {e}"
    db.execute('INSERT OR IGNORE INTO geocache (lat, lon, address) VALUES (?, ?, ?)', (lat, lon, address))
    db.commit()
    return jsonify({'address': address})


if __name__ == '__main__':
    init_db()
    app.run(debug=True)