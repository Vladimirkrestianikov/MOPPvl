// ==================== ПЕРЕМЕННЫЕ ====================
let map;
let selectedLat = 52.290519; // Центр Павлодара
let selectedLng = 76.961078;
let selectedMarker = null;
let markersLayer = L.layerGroup();
let photoFile = null;
let currentUser = null;
let problems = [];
let allProblems = [];
let filters = {
    category: 'all',
    status: 'all',
    date: 'all',
    area: 'all',
    user: 'all'
};
let autoApplyFilters = true;
let adminUsers = ['standoff2moh@gmail.com']; // Замени на свой email

///

// ==================== ПЕРЕМЕННЫЕ ГРАНИЦ (КВАДРАТНЫЕ ПО ПИКСЕЛЯМ) ====================
const centerLat = 52.290519;
const centerLng = 76.961078;

// Задаём размер в километрах ОТ ЦЕНТРА до края (по горизонтали)
// Это даст настоящий квадрат на экране при стандартном проекте Web Mercator
const halfSizeKm = 23; // ~46×46 км квадрат → идеально покрывает Павлодар + пригороды

// Коэффициенты пересчёта
const kmPerDegreeLat = 111.0;
const kmPerDegreeLngAtLatitude = 111.0 * Math.cos(centerLat * Math.PI / 180); // ~68.3 км на 52°

// Половина стороны в градусах (по долготе — определяющий размер, т.к. она "уже")
const halfSizeLng = halfSizeKm / kmPerDegreeLngAtLatitude; // ~0.337°
const halfSizeLat = halfSizeKm / kmPerDegreeLat;           // ~0.207°

// Формируем границы — теперь это будет визуально квадрат!
const pavlodarBounds = L.latLngBounds(
    [centerLat - halfSizeLat, centerLng - halfSizeLng], // ЮЗ
    [centerLat + halfSizeLat, centerLng + halfSizeLng]  // СВ
);

// ====






///////




// Цвета для категорий
const categoryColors = {
    road: '#f44336',
    light: '#ff9800',
    garbage: '#4caf50',
    sidewalk: '#2196f3',
    snow: '#00bcd4',
    other: '#9c27b0'
};

const categoryIcons = {
    road: 'fa-road',
    light: 'fa-lightbulb',
    garbage: 'fa-trash',
    sidewalk: 'fa-walking',
    snow: 'fa-snowflake',
    other: 'fa-exclamation-triangle'
};




// ==================== AI ПОМОЩНИК (анти-429: retry + fallback + лимит-менеджер) ====================
// Защита от 429: retry, задержки, fallback. Работает даже с 5 RPM.
let aiProcessing = false;
let lastRequestTime = 0; // Для rate limiting
const MIN_REQUEST_INTERVAL = 30000; // 30 сек между запросами

// --- 1. Сжатие (всегда работает) ---
async function compressImage(file, maxWidth = 1200, quality = 0.8) {
    return new Promise((resolve) => {
        const img = new Image();
        const reader = new FileReader();
        
        reader.onload = (e) => {
            img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = Math.round((maxWidth / width) * height);
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    resolve(new File([blob], file.name, { type: 'image/jpeg' }));
                }, 'image/jpeg', quality);
            };
        };
        reader.readAsDataURL(file);
    });
}

// --- 2. Fallback: Локальное определение категории (без API) ---
function fallbackCategory(file) {
    const name = file.name.toLowerCase();
    const sizeMB = file.size / (1024 * 1024);
    
    if (name.includes('trash') || name.includes('мусор')) return 'garbage';
    if (sizeMB > 2 && name.includes('jpg') || name.includes('png')) return 'road'; // Большие фото — дороги
    if (name.includes('light') || name.includes('свет')) return 'light';
    
    return 'other'; // Безопасный дефолт
}

// --- 3. Определение категории (с retry на 429) ---
async function detectCategoryFromImage(file, retries = 3) {
    if (!window.GEMINI_API_KEY) {
        console.log('🔑 Нет ключа — fallback категория');
        return fallbackCategory(file);
    }

    const now = Date.now();
    if (now - lastRequestTime < MIN_REQUEST_INTERVAL) {
        await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - (now - lastRequestTime)));
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const base64 = await fileToBase64(file);
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${window.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: "Верни ТОЛЬКО одно слово: road, light, garbage, sidewalk, snow, other. Анализируй фото проблемы." },
                            { inline_data: { mime_type: file.type, data: base64.split(',')[1] } }
                        ]
                    }],
                    generationConfig: { responseMimeType: "text/plain", temperature: 0.1, maxOutputTokens: 5 }
                })
            });

            if (response.status === 429) {
                console.warn(`⚠️ 429 (попытка ${attempt}/${retries}). Ждём 30 сек...`);
                showNotification(`Лимит API (попытка ${attempt}). Ждём...`, 'warning');
                await new Promise(r => setTimeout(r, 30000)); // 30 сек на 429
                continue;
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase();
            
            const valid = ['road', 'light', 'garbage', 'sidewalk', 'snow', 'other'];
            lastRequestTime = Date.now();
            return valid.includes(result) ? result : fallbackCategory(file);
        } catch (e) {
            console.error(`❌ AI категория (попытка ${attempt}):`, e.message);
            if (attempt === retries) {
                showNotification('AI: Использую ручную категорию', 'info');
                return fallbackCategory(file);
            }
        }
    }
    return fallbackCategory(file);
}

// --- 4. Генерация описания (тоже с retry) ---
async function generateDescriptionFromImage(file, retries = 3) {
    if (!window.GEMINI_API_KEY) return null;

    const now = Date.now();
    if (now - lastRequestTime < MIN_REQUEST_INTERVAL) {
        await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - (now - lastRequestTime)));
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const base64 = await fileToBase64(file);
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${window.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: "Короткое описание проблемы на фото: 1 предложение на русском. Пример: 'Яма на дороге у дома 15'." },
                            { inline_data: { mime_type: file.type, data: base64.split(',')[1] } }
                        ]
                    }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 30 }
                })
            });

            if (response.status === 429) {
                console.warn(`⚠️ 429 описание (попытка ${attempt}/${retries})`);
                await new Promise(r => setTimeout(r, 30000));
                continue;
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            lastRequestTime = Date.now();
            return text || null;
        } catch (e) {
            console.error(`❌ AI описание (попытка ${attempt}):`, e.message);
            if (attempt === retries) return null;
        }
    }
    return null;
}

// --- 5. Основная функция (экономит запросы: категория → описание) ---
async function processPhotoWithAI(file) {
    if (aiProcessing) return;
    aiProcessing = true;

    const originalSize = (file.size / 1024 / 1024).toFixed(1);
    showNotification(`🤖 ИИ анализирует (${originalSize} МБ)...`, 'info');

    try {
        // 1. Сжатие (всегда)
        const compressedFile = await compressImage(file, 1200, 0.8);
        const newSize = (compressedFile.size / 1024 / 1024).toFixed(1);
        photoFile = compressedFile;
        showNotification(`Сжатие: ${originalSize}→${newSize} МБ`, 'success');

        // 2. AI (если ключ)
        if (window.GEMINI_API_KEY) {
            // Только категория сначала
            const category = await detectCategoryFromImage(compressedFile);
            if (category && category !== 'other') {
                document.getElementById('problemCategory').value = category;
                const option = document.querySelector(`.category-option[data-category="${category}"]`);
                if (option) option.click();
                showNotification(`Авто: ${getCategoryName(category)}`, 'success');
            }

            // Описание только после паузы
            await new Promise(r => setTimeout(r, 1000)); // 1 сек буфер
            const description = await generateDescriptionFromImage(compressedFile);
            if (description) {
                document.getElementById('problemDescription').value = description;
                showNotification('Авто: Описание готово!', 'success');
            }
        } else {
            // Fallback без ключа
            const fallbackCat = fallbackCategory(file);
            if (fallbackCat !== 'other') {
                document.getElementById('problemCategory').value = fallbackCat;
                showNotification(`Fallback: ${getCategoryName(fallbackCat)}`, 'info');
            }
            showNotification('🔑 Добавь GEMINI_API_KEY для полного AI', 'info');
        }

    } catch (e) {
        console.error('❌ AI общая ошибка:', e);
        photoFile = file; // Fallback
        showNotification('AI: Только сжатие (лимит исчерпан)', 'warning');
    } finally {
        aiProcessing = false;
    }
}

// ==================== КОНЕЦ AI-МОДУЛЯ ====================
// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function formatDate(date) {
    if (!date) return 'Недавно';
    
    if (typeof date === 'string') date = new Date(date);
    if (date && typeof date.toDate === 'function') date = date.toDate();
    if (date && date.seconds) date = new Date(date.seconds * 1000);
    
    if (!(date instanceof Date) || isNaN(date.getTime())) return 'Недавно';
    
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} дн назад`;
    
    return date.toLocaleDateString('ru-RU');
}

function getProblemDate(problem) {
    if (!problem || !problem.createdAt) return new Date();
    const date = problem.createdAt;
    
    if (date && typeof date.toDate === 'function') return date.toDate();
    if (typeof date === 'string') return new Date(date);
    if (date instanceof Date) return date;
    if (date && date.seconds) return new Date(date.seconds * 1000);
    
    return new Date();
}

function checkDateFilter(problem, filter) {
    if (filter === 'all') return true;
    
    const created = getProblemDate(problem);
    const now = new Date();
    
    switch (filter) {
        case 'today':
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return created >= today;
        case 'week':
            const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
            return created >= weekAgo;
        case 'month':
            const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
            return created >= monthAgo;
        default:
            return true;
    }
}

function getCategoryName(category) {
    const names = {
        road: 'Дороги',
        light: 'Освещение',
        garbage: 'Мусор',
        sidewalk: 'Тротуары',
        snow: 'Снег/Лед',
        other: 'Другое'
    };
    return names[category] || 'Другое';
}

function getStatusName(status) {
    const names = {
        new: 'Новая',
        in_progress: 'В работе',
        solved: 'Решено',
        in_work: 'В обработке', // Добавлено
        rejected: 'Отклонена' // Добавлено

    
        
    };
    return names[status] || 'В обработке';
}

function getAuthErrorMessage(error) {
    switch (error.code) {
        case 'auth/email-already-in-use': return 'Email уже используется';
        case 'auth/invalid-email': return 'Неверный email';
        case 'auth/weak-password': return 'Пароль слишком слабый';
        case 'auth/user-not-found': return 'Пользователь не найден';
        case 'auth/wrong-password': return 'Неверный пароль';
        default: return error.message;
    }
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
        <span>${message}</span>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

function isAdmin() {
    return currentUser && adminUsers.includes(currentUser.email);
}

// ==================== СТАТИСТИКА ====================
function updateStats() {
    console.log('🟡 Обновление статистики...');
    
    if (!allProblems || allProblems.length === 0) {
        document.getElementById('totalProblems').textContent = '0';
        document.getElementById('todayProblems').textContent = '0';
        document.getElementById('solvedProblems').textContent = '0';
        
        if (currentUser) {
            const myProblemsElement = document.getElementById('myProblems');
            if (myProblemsElement) myProblemsElement.textContent = '0';
        }
        return;
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    let total = allProblems.length;
    let todayCount = 0;
    let solvedCount = 0;
    let inProgressCount = 0;
    
    allProblems.forEach(problem => {
        const created = getProblemDate(problem);
        if (created >= today) todayCount++;
        if (problem.status === 'solved') solvedCount++;
        if (problem.status === 'in_progress') inProgressCount++;
    });
    
    // Обновляем карточки статистики
    document.getElementById('totalProblems').textContent = total;
    document.getElementById('todayProblems').textContent = todayCount;
    document.getElementById('solvedProblems').textContent = solvedCount;
    
    // Обновляем счетчик "Мои проблемы"
    if (currentUser) {
        const myProblemsCount = allProblems.filter(p => p.userId === currentUser.uid).length;
        const myProblemsElement = document.getElementById('myProblems');
        if (myProblemsElement) {
            myProblemsElement.textContent = myProblemsCount;
        }
    }
}

// ==================== ИНИЦИАЛИЗАЦИЯ КАРТЫ ПАВЛОДАРА ====================
function initMap() {
    console.log('Инициализация карты Павлодара...');

    if (typeof L === 'undefined') {
        showNotification('Ошибка загрузки карты', 'error');
        return;
    }

    // Инициализируем карту с центром в Павлодаре
    const centerLat = 52.2833;
    const centerLng = 76.9667;
    
    // УБРАЛ ВСЕ ОГРАНИЧЕНИЯ - МОЖНО ОТДАЛЯТЬ КУДА ХОЧЕШЬ
    map = L.map('map', {
        zoomControl: false,     // отключаем стандартные кнопки
        center: [centerLat, centerLng],
        zoom: 13,
        maxBounds: null,        // ВООБЩЕ БЕЗ ГРАНИЦ
        maxBoundsViscosity: null // НИКАКОГО ПРИЛИПАНИЯ К ГРАНИЦАМ
    });

    // Добавляем слой карты
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);

    // Слой маркеров
    markersLayer.addTo(map);

    // Маркер добавления проблемы
    selectedMarker = L.marker([centerLat, centerLng], { draggable: true })
        .addTo(map)
        .setIcon(L.divIcon({
            html: '<div style="background: linear-gradient(135deg, #d4af37, #f7ef8a); width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #2e7d32; font-size: 22px; box-shadow: 0 4px 15px rgba(212,175,55,0.6); border: 4px solid white;"><i class="fas fa-map-marker-alt"></i></div>',
            iconSize: [44, 44],
            className: 'custom-marker'
        }));

    selectedMarker.on('dragend', function(e) {
        const pos = e.target.getLatLng();
        selectedLat = pos.lat.toFixed(6);
        selectedLng = pos.lng.toFixed(6);
        updateCoordinates();
    });

    map.on('click', function(e) {
        selectedLat = e.latlng.lat.toFixed(6);
        selectedLng = e.latlng.lng.toFixed(6);
        selectedMarker.setLatLng([selectedLat, selectedLng]);
        updateCoordinates();
    });

    // Если есть границы Павлодара - просто показываем их как визуальный прямоугольник
    if (typeof pavlodarBounds !== 'undefined') {
        L.rectangle(pavlodarBounds, {
            color: '#2e7d32',
            weight: 2,
            fillOpacity: 0.02,
            dashArray: '5, 5'
        }).addTo(map);
    }

    // КНОПКИ УПРАВЛЕНИЯ
    const ZoomControl = L.Control.extend({
        onAdd: function() {
            const div = L.DomUtil.create('div', 'custom-zoom-control');
            div.innerHTML = `
                <button onclick="map.zoomIn()" title="Приблизить"><i class="fas fa-plus"></i></button>
                <button onclick="map.zoomOut()" title="Отдалить"><i class="fas fa-minus"></i></button>
                <button onclick="centerMap()" title="Центр Павлодара"><i class="fas fa-home"></i></button>
                <button onclick="refreshData()" title="Обновить"><i class="fas fa-sync"></i></button>
                <button onclick="zoomToWorld()" title="Весь мир"><i class="fas fa-globe"></i></button>
            `;
            L.DomEvent.disableClickPropagation(div);
            return div;
        }
    });

    new ZoomControl({ position: 'topright' }).addTo(map);

    // Функция центрирования карты на Павлодаре
    window.centerMap = function() {
        map.setView([centerLat, centerLng], 13);
        selectedMarker.setLatLng([centerLat, centerLng]);
        selectedLat = centerLat.toFixed(6);
        selectedLng = centerLng.toFixed(6);
        updateCoordinates();
    };

    // Функция для отдаления на весь мир
    window.zoomToWorld = function() {
        map.setView([20, 0], 2); // Весь мир
    };

    console.log('Карта готова - можно отдаляться сколько хочешь!');
    loadProblems();
}

// ==================== РАБОТА С ФОРМОЙ ====================
function initializeForm() {
    // Выбор категории
    document.querySelectorAll('.category-option[data-category]').forEach(option => {
        option.addEventListener('click', function() {
            document.querySelectorAll('.category-option[data-category]').forEach(opt => {
                opt.classList.remove('active');
            });
            this.classList.add('active');
            document.getElementById('problemCategory').value = this.dataset.category;
        });
    });

    // Загрузка фото
    document.getElementById('photoUpload').addEventListener('click', () => {
        document.getElementById('photoInput').click();
    });

document.getElementById('photoInput').addEventListener('change', async function(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 7 * 1024 * 1024) {
        showNotification('Слишком большой! Макс. 7 МБ', 'error');
        return;
    }

    // Превью сразу
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('previewImage').src = e.target.result;
        document.getElementById('photoPreview').style.display = 'block';
        document.getElementById('photoUpload').style.display = 'none';
    };
    reader.readAsDataURL(file);

    // AI асинхронно
    processPhotoWithAI(file);
});
    // Автоматическое применение фильтров
    const autoApplyCheckbox = document.getElementById('autoApplyFilters');
    if (autoApplyCheckbox) {
        autoApplyCheckbox.addEventListener('change', function() {
            autoApplyFilters = this.checked;
            localStorage.setItem('autoApplyFilters', autoApplyFilters);
            
            if (autoApplyFilters) {
                applyFilters();
            }
        });
        
        // Загружаем настройку
        const savedSetting = localStorage.getItem('autoApplyFilters');
        if (savedSetting !== null) {
            autoApplyFilters = savedSetting === 'true';
            autoApplyCheckbox.checked = autoApplyFilters;
        }
    }
    
    // Слушатели изменений фильтров для автоматического применения
    ['categoryFilter', 'statusFilter', 'dateFilter', 'areaFilter', 'userFilter'].forEach(filterId => {
        const element = document.getElementById(filterId);
        if (element) {
            element.addEventListener('change', function() {
                if (autoApplyFilters) {
                    setTimeout(applyFilters, 100);
                }
            });
        }
    });
}

function clearPhoto() {
    photoFile = null;
    document.getElementById('photoInput').value = '';
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoUpload').style.display = 'block';
}

function updateCoordinates() {
    document.getElementById('latValue').textContent = selectedLat;
    document.getElementById('lngValue').textContent = selectedLng;
}

function clearForm() {
    document.getElementById('problemTitle').value = '';
    document.getElementById('problemDescription').value = '';
    clearPhoto();
}

// ==================== НАВИГАЦИОННОЕ МЕНЮ ПОЛЬЗОВАТЕЛЯ ====================
function initializeUserMenu() {
    const userMenu = document.querySelector('.user-menu');
    const dropdown = document.querySelector('.dropdown-content');
    
    if (userMenu && dropdown) {
        // Клик по меню пользователя
        userMenu.addEventListener('click', function(e) {
            e.stopPropagation();
            dropdown.classList.toggle('show');
        });
        
        // Закрытие при клике вне меню
        document.addEventListener('click', function() {
            dropdown.classList.remove('show');
        });
        
        // Предотвращение закрытия при клике внутри меню
        dropdown.addEventListener('click', function(e) {
            e.stopPropagation();
        });
    }
}

function showAccountSettings() {
    const userName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Пользователь';
    const userEmail = currentUser?.email || 'Не указан';
    
    const settingsHtml = `
        <div class="admin-modal" id="accountSettingsModal">
            <div class="admin-content">
                <div class="admin-header">
                    <h2><i class="fas fa-user-cog" style="color: #d4af37;"></i> Настройки аккаунта</h2>
                    <button class="auth-btn logout-btn" onclick="hideAccountSettings()">
                        <i class="fas fa-times"></i> Закрыть
                    </button>
                </div>
                
                <div style="padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #4caf50, #8bc34a); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 15px; color: white; font-size: 32px; font-weight: bold;">
                            ${userName.charAt(0).toUpperCase()}
                        </div>
                        <h3 style="color: #2e7d32; margin-bottom: 5px;">${userName}</h3>
                        <p style="color: #666;">${userEmail}</p>
                    </div>
                    
                    <div style="display: grid; gap: 15px;">
                        <div style="background: #f9f9f9; padding: 15px; border-radius: 10px; border: 1px solid #e0e0e0;">
                            <h4 style="color: #2e7d32; margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
                                <i class="fas fa-chart-bar"></i> Моя статистика
                            </h4>
                            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
                                <div style="text-align: center;">
                                    <div style="font-size: 1.5rem; font-weight: bold; color: #2e7d32;" id="myProblemsStat">0</div>
                                    <div style="font-size: 0.85rem; color: #666;">Мои проблемы</div>
                                </div>
                                <div style="text-align: center;">
                                    <div style="font-size: 1.5rem; font-weight: bold; color: #2e7d32;" id="solvedProblemsStat">0</div>
                                    <div style="font-size: 0.85rem; color: #666;">Решено</div>
                                </div>
                            </div>
                        </div>
                        
                        <div style="background: #f9f9f9; padding: 15px; border-radius: 10px; border: 1px solid #e0e0e0;">
                            <h4 style="color: #2e7d32; margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
                                <i class="fas fa-sliders-h"></i> Настройки
                            </h4>
                            <div style="display: flex; flex-direction: column; gap: 10px;">
                                <label class="auto-apply-label">
                                    <input type="checkbox" id="settingsAutoApply" class="auto-apply-checkbox">
                                    Автоматически применять фильтры
                                </label>
                                <label class="auto-apply-label">
                                    <input type="checkbox" id="notificationsEnabled" class="auto-apply-checkbox" checked>
                                    Уведомления о новых проблемах
                                </label>
                            </div>
                        </div>
                        
                        ${isAdmin() ? `
                            <div style="background: linear-gradient(135deg, #fef9e7, #fff8e1); padding: 15px; border-radius: 10px; border: 1px solid #d4af37;">
                                <h4 style="color: #2e7d32; margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
                                    <i class="fas fa-crown"></i> Администратор
                                </h4>
                                <p style="color: #666; margin-bottom: 10px;">Вы являетесь администратором системы.</p>
                                <button class="filter-btn apply-btn" onclick="showAdminPanel(); hideAccountSettings()" style="width: 100%;">
                                    <i class="fas fa-cog"></i> Панель администратора
                                </button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        </div>
    `;
    ф
    // Удаляем существующее модальное окно если есть
    const existingModal = document.getElementById('accountSettingsModal');
    if (existingModal) existingModal.remove();
    
    // Добавляем новое модальное окно
    document.body.insertAdjacentHTML('beforeend', settingsHtml);
    
    // Показываем модальное окно
    document.getElementById('accountSettingsModal').style.display = 'flex';
    
    // Загружаем статистику
    updateAccountStats();
    
    // Настройка чекбокса автоматического применения
    const autoApplyCheckbox = document.getElementById('settingsAutoApply');
    if (autoApplyCheckbox) {
        autoApplyCheckbox.checked = autoApplyFilters;
        autoApplyCheckbox.addEventListener('change', function() {
            autoApplyFilters = this.checked;
            localStorage.setItem('autoApplyFilters', autoApplyFilters);
            document.getElementById('autoApplyFilters').checked = autoApplyFilters;
        });
    }
}

function hideAccountSettings() {
    const modal = document.getElementById('accountSettingsModal');
    if (modal) modal.style.display = 'none';
}

function updateAccountStats() {
    if (!currentUser) return;
    
    const myProblems = allProblems.filter(p => p.userId === currentUser.uid).length;
    const solvedProblems = allProblems.filter(p => p.userId === currentUser.uid && p.status === 'solved').length;
    
    const myProblemsStat = document.getElementById('myProblemsStat');
    const solvedProblemsStat = document.getElementById('solvedProblemsStat');
    
    if (myProblemsStat) myProblemsStat.textContent = myProblems;
    if (solvedProblemsStat) solvedProblemsStat.textContent = solvedProblems;
}

// ==================== ФИЛЬТРЫ ====================
function shouldShowProblem(problem) {
    if (filters.category !== 'all' && problem.category !== filters.category) return false;
    if (filters.status !== 'all' && problem.status !== filters.status) return false;
    if (filters.date !== 'all' && !checkDateFilter(problem, filters.date)) return false;
    if (filters.user === 'my' && currentUser && problem.userId !== currentUser.uid) return false;
    return true;
}

function applyFilters() {
    // Собираем фильтры
    filters.category = document.getElementById('categoryFilter').value;
    filters.status = document.getElementById('statusFilter').value;
    filters.date = document.getElementById('dateFilter').value;
    filters.area = document.getElementById('areaFilter').value;
    filters.user = document.getElementById('userFilter').value;
    
    // Очищаем карту
    markersLayer.clearLayers();
    
    // Фильтруем проблемы
    let filteredProblems = allProblems.filter(problem => shouldShowProblem(problem));
    problems = filteredProblems;
    
    // Добавляем отфильтрованные маркеры
    problems.forEach(problem => {
        addMarkerToMap(problem);
    });
    
    // Обновляем счетчик
    updateFilteredCount();
    
    // Сохраняем фильтры
    saveFilters();
}

function saveFilters() {
    localStorage.setItem('filters', JSON.stringify(filters));
}

function loadFilters() {
    const savedFilters = localStorage.getItem('filters');
    if (savedFilters) {
        try {
            filters = JSON.parse(savedFilters);
            
            // Восстанавливаем значения в селектах
            document.getElementById('categoryFilter').value = filters.category;
            document.getElementById('statusFilter').value = filters.status;
            document.getElementById('dateFilter').value = filters.date;
            document.getElementById('areaFilter').value = filters.area;
            document.getElementById('userFilter').value = filters.user;
            
            console.log('✅ Фильтры загружены:', filters);
        } catch (e) {
            console.error('Ошибка загрузки фильтров:', e);
        }
    }
}

function clearFilters() {
    filters = {
        category: 'all',
        status: 'all',
        date: 'all',
        area: 'all',
        user: 'all'
    };
    
    document.getElementById('categoryFilter').value = 'all';
    document.getElementById('statusFilter').value = 'all';
    document.getElementById('dateFilter').value = 'all';
    document.getElementById('areaFilter').value = 'all';
    document.getElementById('userFilter').value = 'all';
    
    saveFilters();
    
    if (autoApplyFilters) {
        applyFilters();
    } else {
        markersLayer.clearLayers();
        problems = [...allProblems];
        problems.forEach(problem => addMarkerToMap(problem));
        updateFilteredCount();
    }
    
    showNotification('Все фильтры сброшены', 'success');
}

function updateFilteredCount() {
    const count = problems.length;
    const total = allProblems.length;
    
    const filteredCountElement = document.getElementById('filteredCount');
    if (filteredCountElement) {
        if (count === total) {
            filteredCountElement.textContent = 'Все проблемы';
        } else {
            filteredCountElement.textContent = `${count} из ${total} проблем`;
        }
    }
}

function openFullImage(base64) {
    // Удаляем старое модальное окно, если есть
    const existing = document.getElementById('fullImageModal');
    if (existing) existing.remove();

    const modalHtml = `
        <div id="fullImageModal" style="
            position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
            background: rgba(0,0,0,0.95); z-index: 9999; display: flex; 
            align-items: center; justify-content: center; padding: 20px;
            animation: fadeIn 0.3s ease;">
            <div style="position: relative; max-width: 95%; max-height: 95%;">
                <img src="${base64}" style="max-width: 100%; max-height: 95vh; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                <button onclick="document.getElementById('fullImageModal').remove()" 
                        style="position: absolute; top: -15px; right: -15px; 
                               width: 44px; height: 44px; background: #fff; 
                               border: none; border-radius: 50%; font-size: 24px;
                               cursor: pointer; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
                    ×
                </button>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Закрытие по клику на фон
    document.getElementById('fullImageModal').addEventListener('click', function(e) {
        if (e.target === this) this.remove();
    });
}

// ==================== РАБОТА С КАРТОЙ ====================
function addMarkerToMap(problem) {
    const color = categoryColors[problem.category] || '#9c27b0';
    const icon = categoryIcons[problem.category] || 'fa-exclamation-triangle';
    
    // Создаем иконку с фиксированными размерами
    const customIcon = L.divIcon({
        html: `
            <div style="
                background: ${color};
                width: 36px;
                height: 36px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 16px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                border: 3px solid white;
                cursor: pointer;
                transform: translate(-50%, -50%);
            ">
                <i class="fas ${icon}"></i>
            </div>
        `,
        iconSize: [36, 36], // Фиксированный размер
        iconAnchor: [18, 18], // Центрирование иконки
        popupAnchor: [0, -18], // Смещение попапа
        className: 'problem-marker'
    });
    
    const marker = L.marker([problem.latitude, problem.longitude], {
        icon: customIcon
    }).addTo(markersLayer);
    
    // Получаем статус цвета
    let statusColor, statusText;
    switch (problem.status) {
        case 'solved':
            statusColor = '#4caf50';
            statusText = 'Решено';
            break;
        case 'in_progress':
            statusColor = '#ff9800';
            statusText = 'В работе';
            break;
        case 'processing':
            statusColor = '#2196f3';
            statusText = 'В обработке';
            break;
        case 'rejected':
            statusColor = '#9e9e9e';
            statusText = 'Отклонена';
            break;
        default:
            statusColor = '#f44336';
            statusText = 'Новая';
    }
    
    // Упрощенный и компактный попап
    const popupContent = `
        <div style="min-width: 200px; max-width: 250px; font-size: 14px;">
            <div style="
                background: ${color};
                color: white;
                padding: 8px 12px;
                border-radius: 8px 8px 0 0;
                margin: -8px -12px 8px;
                font-weight: bold;
                font-size: 15px;
                display: flex;
                align-items: center;
                gap: 8px;
            ">
                <i class="fas ${icon}"></i>
                <span>${problem.title || 'Проблема'}</span>
            </div>
            
            <div style="margin-bottom: 10px;">
                <div style="
                    background: ${statusColor};
                    color: white;
                    padding: 4px 8px;
                    border-radius: 12px;
                    font-size: 12px;
                    display: inline-block;
                    margin-bottom: 8px;
                ">
                    ${statusText}
                </div>
                
                <p style="margin: 0 0 10px; line-height: 1.4; color: #555;">
                    ${problem.description || 'Без описания'}
                </p>
                
                <div style="font-size: 12px; color: #777;">
                    <div><i class="fas fa-user"></i> ${problem.userName || 'Аноним'}</div>
                    <div><i class="fas fa-calendar"></i> ${formatDate(getProblemDate(problem))}</div>
                </div>
            </div>
            
            ${problem.photoBase64 ? `
                <div style="margin-top: 10px; cursor: pointer;" 
                     onclick="openFullImage('${problem.photoBase64.replace(/'/g, "\\'")}')">
                    <img src="${problem.photoBase64}" 
                         alt="Фото"
                         style="width: 100%; max-height: 120px; object-fit: cover; border-radius: 6px; border: 1px solid #ddd;">
                    <div style="font-size: 11px; color: #666; text-align: center; margin-top: 4px;">
                        Нажмите для увеличения
                    </div>
                </div>
            ` : ''}
            
            <div style="margin-top: 12px; display: flex; gap: 5px; flex-wrap: wrap;">
                ${currentUser && currentUser.uid === problem.userId ? `
                    <button onclick="deleteProblem('${problem.id}')" 
                            style="
                                background: #f44336; 
                                color: white; 
                                border: none; 
                                padding: 6px 10px; 
                                border-radius: 6px; 
                                cursor: pointer; 
                                font-size: 12px;
                                flex: 1;
                                min-width: 80px;
                            ">
                        <i class="fas fa-trash"></i> Удалить
                    </button>
                ` : ''}
                
                ${isAdmin() ? `
                    <div style="display: flex; gap: 5px; flex-wrap: wrap; width: 100%;">
                        <button onclick="changeProblemStatus('${problem.id}', 'in_progress')" 
                                style="
                                    background: #ff9800; 
                                    color: white; 
                                    border: none; 
                                    padding: 6px 8px; 
                                    border-radius: 6px; 
                                    cursor: pointer; 
                                    font-size: 11px;
                                    flex: 1;
                                    min-width: 60px;
                                ">
                            <i class="fas fa-wrench"></i>
                        </button>
                        <button onclick="changeProblemStatus('${problem.id}', 'processing')" 
                                style="
                                    background: #2196f3; 
                                    color: white; 
                                    border: none; 
                                    padding: 6px 8px; 
                                    border-radius: 6px; 
                                    cursor: pointer; 
                                    font-size: 11px;
                                    flex: 1;
                                    min-width: 60px;
                                ">
                            <i class="fas fa-cog"></i>
                        </button>
                        <button onclick="changeProblemStatus('${problem.id}', 'rejected')" 
                                style="
                                    background: #9e9e9e; 
                                    color: white; 
                                    border: none; 
                                    padding: 6px 8px; 
                                    border-radius: 6px; 
                                    cursor: pointer; 
                                    font-size: 11px;
                                    flex: 1;
                                    min-width: 60px;
                                ">
                            <i class="fas fa-times"></i>
                        </button>
                        <button onclick="changeProblemStatus('${problem.id}', 'solved')" 
                                style="
                                    background: #4caf50; 
                                    color: white; 
                                    border: none; 
                                    padding: 6px 8px; 
                                    border-radius: 6px; 
                                    cursor: pointer; 
                                    font-size: 11px;
                                    flex: 1;
                                    min-width: 60px;
                                ">
                            <i class="fas fa-check"></i>
                        </button>
                    </div>
                ` : ''}
            </div>
        </div>
    `;
    
    marker.bindPopup(popupContent);
}

function useMyLocation() {
    const btn = document.getElementById('locationBtn');
    const originalText = btn.innerHTML;
    
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Определяем...';
    btn.disabled = true;
    
    if (!navigator.geolocation) {
        showNotification('Геолокация не поддерживается', 'error');
        btn.innerHTML = originalText;
        btn.disabled = false;
        return;
    }
    
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            
            if (pavlodarBounds.contains([lat, lng])) {
                selectedLat = lat.toFixed(6);
                selectedLng = lng.toFixed(6);
                selectedMarker.setLatLng([selectedLat, selectedLng]);
                map.setView([selectedLat, selectedLng], 16);
                updateCoordinates();
                showNotification('Местоположение определено!', 'success');
            } else {
                showNotification('Вы находитесь за пределами Павлодара', 'warning');
                centerMap();
            }
            
            btn.innerHTML = originalText;
            btn.disabled = false;
        },
        (error) => {
            showNotification('Не удалось определить местоположение', 'error');
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    );
}

function centerMap() {
    map.setView([52.290519, 76.961078], 13); // Центр Павлодара
    selectedMarker.setLatLng([52.290519, 76.961078]);
    selectedLat = 52.290519;
    selectedLng = 76.961078;
    updateCoordinates();
}

function refreshData() {
    loadProblems();
    showNotification('Данные обновлены', 'success');
}

// ==================== FIREBASE ИНИЦИАЛИЗАЦИЯ И АУТЕНТИФИКАЦИЯ ====================
function initializeFirebase() {
    console.log('🟡 Проверяем инициализацию Firebase...');
    
    try {
        // Проверяем, инициализирован ли Firebase
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
            console.log('✅ Firebase инициализирован');
        } else {
            console.log('✅ Firebase уже инициализирован');
        }
        
        // Проверяем доступность сервисов
        if (!window.auth || !window.db || !window.storage) {
            console.warn('⚠️ Firebase сервисы не найдены в window, создаем...');
            window.auth = firebase.auth();
            window.db = firebase.firestore();
            window.storage = firebase.storage();
        }
        
        console.log('✅ Firebase сервисы готовы:', {
            auth: !!window.auth,
            db: !!window.db,
            storage: !!window.storage
        });
        
        // Настраиваем слушатель состояния аутентификации
        setupAuthListener();
        
    } catch (error) {
        console.error('❌ Ошибка инициализации Firebase:', error);
        showNotification('Ошибка загрузки приложения', 'error');
    }
}

function setupAuthListener() {
    console.log('🟡 Настройка слушателя аутентификации...');
    
    auth.onAuthStateChanged((user) => {
        console.log('🔐 Изменение состояния аутентификации:', user ? 'Пользователь вошел' : 'Пользователь вышел');
        
        if (user) {
            // Пользователь вошел
            currentUser = {
                uid: user.uid,
                email: user.email,
                displayName: user.displayName || user.email.split('@')[0],
                photoURL: user.photoURL
            };
            
            // Обновляем UI
            updateAuthUI();
            
            // Загружаем проблемы
            loadProblems();
            
            // Показываем приветствие
            showNotification(`Добро пожаловать, ${currentUser.displayName}!`, 'success');
            
        } else {
            // Пользователь вышел
            currentUser = null;
            updateAuthUI();
            
            // Очищаем проблемы или показываем только публичные
            if (autoApplyFilters) {
                allProblems = [];
                problems = [];
                markersLayer.clearLayers();
                updateStats();
                updateFilteredCount();
            }
        }
    }, (error) => {
        console.error('Ошибка слушателя аутентификации:', error);
    });
}

function updateAuthUI() {
    const authSection = document.getElementById('authSection');
    const userInfo = document.getElementById('userInfo');
    const loginBtn = document.querySelector('.login-btn');
    const userName = document.getElementById('userName');
    const userAvatar = document.getElementById('userAvatar');
    const adminBtn = document.getElementById('adminBtn');
    
    if (currentUser) {
        // Пользователь вошел
        if (loginBtn) loginBtn.style.display = 'none';
        if (userInfo) userInfo.style.display = 'flex';
        if (userName) userName.textContent = currentUser.displayName;
        if (userAvatar) {
            if (currentUser.photoURL) {
                userAvatar.style.backgroundImage = `url(${currentUser.photoURL})`;
                userAvatar.textContent = '';
            } else {
                userAvatar.textContent = currentUser.displayName.charAt(0).toUpperCase();
                userAvatar.style.backgroundImage = 'none';
                userAvatar.style.background = 'linear-gradient(135deg, #4caf50, #8bc34a)';
            }
        }
        
        // Проверяем админские права
        if (adminBtn) {
            adminBtn.style.display = isAdmin() ? 'flex' : 'none';
        }
        
        // Обновляем фильтр "Мои проблемы"
        const userFilter = document.getElementById('userFilter');
        if (userFilter) {
            if (!userFilter.querySelector('option[value="my"]')) {
                userFilter.innerHTML += '<option value="my">Мои проблемы</option>';
            }
        }
        
    } else {
        // Пользователь вышел
        if (loginBtn) loginBtn.style.display = 'flex';
        if (userInfo) userInfo.style.display = 'none';
        
        // Убираем опцию "Мои проблемы"
        const userFilter = document.getElementById('userFilter');
        if (userFilter) {
            const myOption = userFilter.querySelector('option[value="my"]');
            if (myOption) myOption.remove();
        }
    }
}

// ==================== АУТЕНТИФИКАЦИЯ ====================
function showAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.style.display = 'flex';
        // Показываем форму входа по умолчанию
        showLoginForm();
    }
}

function hideAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.style.display = 'none';
        // Очищаем поля форм
        document.getElementById('loginEmail').value = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('registerName').value = '';
        document.getElementById('registerEmail').value = '';
        document.getElementById('registerPassword').value = '';
    }
}

function showLoginForm() {
    document.getElementById('loginForm').classList.add('active');
    document.getElementById('registerForm').classList.remove('active');
    
    // Обновляем активные вкладки
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelector('.auth-tab:first-child').classList.add('active');
}

function showRegisterForm() {
    document.getElementById('loginForm').classList.remove('active');
    document.getElementById('registerForm').classList.add('active');
    
    // Обновляем активные вкладки
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelector('.auth-tab:last-child').classList.add('active');
}

async function login() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    
    if (!email || !password) {
        showNotification('Заполните все поля', 'warning');
        return;
    }
    
    const submitBtn = document.querySelector('#loginForm .auth-submit');
    const originalText = submitBtn.textContent;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Вход...';
    submitBtn.disabled = true;
    
    try {
        await auth.signInWithEmailAndPassword(email, password);
        hideAuthModal();
        showNotification('Вход выполнен успешно!', 'success');
    } catch (error) {
        console.error('Ошибка входа:', error);
        showNotification(getAuthErrorMessage(error), 'error');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}

async function register() {
    const name = document.getElementById('registerName').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    
    if (!name || !email || !password) {
        showNotification('Заполните все поля', 'warning');
        return;
    }
    
    if (password.length < 6) {
        showNotification('Пароль должен содержать минимум 6 символов', 'warning');
        return;
    }
    
    const submitBtn = document.querySelector('#registerForm .auth-submit');
    const originalText = submitBtn.textContent;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Регистрация...';
    submitBtn.disabled = true;
    
    try {
        // Регистрируем пользователя
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        
        // Обновляем профиль с именем
        await userCredential.user.updateProfile({
            displayName: name
        });
        
        // Создаем запись пользователя в Firestore
        await db.collection('users').doc(userCredential.user.uid).set({
            name: name,
            email: email,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            role: 'user'
        }, { merge: true });
        
        hideAuthModal();
        showNotification('Регистрация успешна!', 'success');
        
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        showNotification(getAuthErrorMessage(error), 'error');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}

async function logout() {
    if (!confirm('Вы уверены, что хотите выйти?')) return;
    
    try {
        await auth.signOut();
        showNotification('Вы вышли из системы', 'info');
    } catch (error) {
        console.error('Ошибка выхода:', error);
        showNotification('Ошибка при выходе', 'error');
    }
}

// ==================== РАБОТА С ПРОБЛЕМАМИ (FIREBASE) ====================
async function loadProblems() {
    console.log('🟡 Загрузка проблем из Firebase...');
    
    const loadingElement = document.getElementById('adminProblemsList');
    if (loadingElement) {
        loadingElement.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> Загрузка проблем...</p>';
    }
    
    try {
        // Получаем проблемы из Firestore
        const snapshot = await db.collection('problems')
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();
        
        allProblems = [];
        
        snapshot.forEach(doc => {
            const problem = {
                id: doc.id,
                ...doc.data()
            };
            
            // Преобразуем Timestamp в Date если нужно
            if (problem.createdAt && typeof problem.createdAt.toDate === 'function') {
                problem.createdAt = problem.createdAt.toDate();
            }
            
            allProblems.push(problem);
        });
        
        console.log(`✅ Загружено ${allProblems.length} проблем`);
        
        // Применяем текущие фильтры
        if (autoApplyFilters) {
            applyFilters();
        } else {
            // Показываем все проблемы
            problems = [...allProblems];
            markersLayer.clearLayers();
            problems.forEach(problem => addMarkerToMap(problem));
            updateFilteredCount();
        }
        
        // Обновляем статистику
        updateStats();
        
        // Обновляем счетчик "Мои проблемы"
        if (currentUser) {
            const myProblemsCount = allProblems.filter(p => p.userId === currentUser.uid).length;
            document.getElementById('myProblems').textContent = myProblemsCount;
        }
        
    } catch (error) {
        console.error('Ошибка загрузки проблем:', error);
        showNotification('Ошибка загрузки данных', 'error');
        
        // Показываем демо-данные если нет подключения
        if (allProblems.length === 0) {
            loadDemoProblems();
        }
    }
}

async function addProblem() {
    if (!currentUser) {
        showNotification('Для добавления проблемы необходимо войти в систему', 'warning');
        showAuthModal();
        return;
    }

    const title = document.getElementById('problemTitle').value.trim();
    const description = document.getElementById('problemDescription').value.trim();
    const category = document.getElementById('problemCategory').value;

    if (!title) {
        showNotification('Введите кратное описание проблемы', 'warning');
        return;
    }
    if (!category) {
        showNotification('Выберите категорию проблемы', 'warning');
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Добавление...';
    submitBtn.disabled = true;

    try {
        let photoBase64 = null;

        // Если есть фото — конвертируем в base64
        if (photoFile) {
            photoBase64 = await fileToBase64(photoFile);
            // Ограничиваем размер (рекомендую ≤ 1.5 МБ после кодирования)
            if (photoBase64.length > 2 * 1024 * 1024) { // ~2MB
                showNotification('Фото слишком большое! Максимум ~1.5 МБ', 'error');
                return;
            }
        }

        const problemData = {
            title: title,
            description: description,
            category: category,
            status: 'in_work',
            latitude: parseFloat(selectedLat),
            longitude: parseFloat(selectedLng),
            photoBase64: photoBase64,        // ← Теперь base64
            hasPhoto: !!photoBase64,          // ← Для быстрой фильтрации
            userId: currentUser.uid,
            userName: currentUser.displayName || currentUser.email.split('@')[0],
            userEmail: currentUser.email,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('problems').add(problemData);

        clearForm();
        showNotification('Проблема успешно добавлена!', 'success');
        loadProblems(); // перезагрузим с новой базой

    } catch (error) {
        console.error('Ошибка добавления проблемы:', error);
        showNotification('Ошибка при добавлении', 'error');
    } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result); // например: data:image/jpeg;base64,/9j/4AAQSkZJRg...
        reader.onerror = error => reject(error);
    });
}

async function uploadPhoto(file) {
    return new Promise((resolve, reject) => {
        const storageRef = storage.ref();
        const timestamp = Date.now();
        const fileName = `problems/${currentUser.uid}/${timestamp}_${file.name}`;
        const uploadTask = storageRef.child(fileName).put(file);
        
        uploadTask.on('state_changed',
            (snapshot) => {
                // Прогресс загрузки
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                console.log(`Upload is ${progress}% done`);
            },
            (error) => {
                console.error('Ошибка загрузки фото:', error);
                reject(error);
            },
            async () => {
                // Загрузка завершена
                const downloadURL = await uploadTask.snapshot.ref.getDownloadURL();
                resolve(downloadURL);
            }
        );
    });
}

async function deleteProblem(problemId) {
    if (!currentUser) {
        showNotification('Необходимо войти в систему', 'warning');
        return;
    }
    
    const problem = allProblems.find(p => p.id === problemId);
    if (!problem) return;
    
    if (problem.userId !== currentUser.uid) {
        showNotification('Вы можете удалять только свои проблемы', 'warning');
        return;
    }
    
    if (!confirm('Вы уверены, что хотите удалить эту проблему?')) return;
    
    try {
        // Удаляем из Firestore
        await db.collection('problems').doc(problemId).delete();
        
        // Удаляем фото из Storage если есть
        if (problem.photoUrl) {
            try {
                const photoRef = storage.refFromURL(problem.photoUrl);
                await photoRef.delete();
            } catch (error) {
                console.warn('Не удалось удалить фото:', error);
            }
        }
        
        showNotification('Проблема удалена', 'success');
        loadProblems();
        
    } catch (error) {
        console.error('Ошибка удаления проблемы:', error);
        showNotification('Ошибка при удалении проблемы', 'error');
    }
}

async function changeProblemStatus(problemId, newStatus) {
    if (!isAdmin()) {
        showNotification('Только администраторы могут изменять статусы', 'warning');
        return;
    }
    
    try {
        await db.collection('problems').doc(problemId).update({
            status: newStatus,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        showNotification(`Статус изменен на "${getStatusName(newStatus)}"`, 'success');
        loadProblems();
        
    } catch (error) {
        console.error('Ошибка изменения статуса:', error);
        showNotification('Ошибка при изменении статуса', 'error');
    }
}

async function deleteProblemAdmin(problemId) {
    if (!isAdmin()) {
        showNotification('Доступ запрещен', 'error');
        return;
    }
    
    if (!confirm('Вы уверены, что хотите удалить эту проблему? Это действие нельзя отменить.')) {
        return;
    }
    
    try {
        const problem = allProblems.find(p => p.id === problemId);
        
        // Удаляем из Firestore
        await db.collection('problems').doc(problemId).delete();
        
        // Удаляем фото из Storage если есть
        if (problem && problem.photoUrl) {
            try {
                const photoRef = storage.refFromURL(problem.photoUrl);
                await photoRef.delete();
            } catch (error) {
                console.warn('Не удалось удалить фото:', error);
            }
        }
        
        showNotification('Проблема удалена администратором', 'success');
        loadProblems();
        
    } catch (error) {
        console.error('Ошибка удаления проблемы:', error);
        showNotification('Ошибка при удалении проблемы', 'error');
    }
}

// ==================== ДЕМО-ДАННЫЕ (если нет подключения) ====================


// ==================== АДМИН ПАНЕЛЬ ====================
function showAdminPanel() {
    if (!isAdmin()) {
        showNotification('Доступ запрещен', 'error');
        return;
    }
    
    const modal = document.getElementById('adminModal');
    if (modal) {
        modal.style.display = 'flex';
        loadAdminData();
    }
}

function hideAdminPanel() {
    const modal = document.getElementById('adminModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function loadAdminData() {
    try {
        // Загружаем проблемы для админа
        const problemsList = document.getElementById('adminProblemsList');
        if (problemsList) {
            let html = '<div style="display: flex; flex-direction: column; gap: 10px;">';
            
            allProblems.slice(0, 10).forEach(problem => {
                // Определяем цвет категории и статус
                const color = categoryColors[problem.category] || '#4db6ac';
                const icon = categoryIcons[problem.category] || 'fa-exclamation-triangle';
                
                let statusColor, statusText;
                switch (problem.status) {
                    case 'solved':
                        statusColor = '#66bb6a';
                        statusText = 'Решено';
                        break;
                    case 'in_progress':
                        statusColor = '#ffd54f';
                        statusText = 'В работе';
                        break;
                    default:
                        statusColor = '#80cbc4';
                        statusText = 'Новая';
                }
                
                html += `
                    <div style="
                        background: #e8f4f8;
                        padding: 12px;
                        border-radius: 10px;
                        border: 1px solid #b2dfdb;
                        box-shadow: 0 1px 3px rgba(0, 121, 107, 0.1);
                    ">
                        <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
                            <div style="flex: 1;">
                                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                                    <div style="
                                        background: ${color};
                                        min-width: 28px;
                                        height: 28px;
                                        border-radius: 50%;
                                        display: flex;
                                        align-items: center;
                                        justify-content: center;
                                        color: white;
                                        font-size: 12px;
                                        border: 2px solid white;
                                    ">
                                        <i class="fas ${icon}"></i>
                                    </div>
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="color: #00695c; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${problem.title}</div>
                                        <span style="
                                            background: ${statusColor};
                                            color: ${statusColor === '#ffd54f' ? '#5d4037' : 'white'};
                                            padding: 2px 8px;
                                            border-radius: 10px;
                                            font-size: 10px;
                                            font-weight: 500;
                                            display: inline-block;
                                            margin-top: 3px;
                                        ">
                                            ${statusText}
                                        </span>
                                    </div>
                                </div>
                                <div style="font-size: 11px; color: #00796b; display: flex; gap: 10px;">
                                    <span style="display: flex; align-items: center; gap: 3px;">
                                        <i class="fas fa-user" style="opacity: 0.7; font-size: 10px;"></i> ${problem.userName || 'Аноним'}
                                    </span>
                                    <span style="display: flex; align-items: center; gap: 3px;">
                                        <i class="fas fa-calendar" style="opacity: 0.7; font-size: 10px;"></i> ${formatDate(problem.createdAt)}
                                    </span>
                                </div>
                            </div>
                            <div style="display: flex; gap: 5px; flex-shrink: 0;">
                                ${problem.status === 'new' ? 
                                    `<button onclick="changeProblemStatus('${problem.id}', 'in_progress')" style="
                                        background: #ffd54f;
                                        color: #5d4037;
                                        border: none;
                                        padding: 4px 8px;
                                        border-radius: 6px;
                                        cursor: pointer;
                                        font-size: 11px;
                                        font-weight: 500;
                                        display: flex;
                                        align-items: center;
                                        gap: 4px;
                                        white-space: nowrap;
                                        height: 26px;
                                    ">
                                        <i class="fas fa-wrench" style="font-size: 10px;"></i> В работу
                                    </button>` : 
                                    problem.status === 'in_progress' ?
                                    `<button onclick="changeProblemStatus('${problem.id}', 'solved')" style="
                                        background: #66bb6a;
                                        color: white;
                                        border: none;
                                        padding: 4px 8px;
                                        border-radius: 6px;
                                        cursor: pointer;
                                        font-size: 11px;
                                        font-weight: 500;
                                        display: flex;
                                        align-items: center;
                                        gap: 4px;
                                        white-space: nowrap;
                                        height: 26px;
                                    ">
                                        <i class="fas fa-check" style="font-size: 10px;"></i> Решено
                                    </button>` : ''
                                }
                                <button onclick="deleteProblemAdmin('${problem.id}')" style="
                                    background: #80cbc4;
                                    color: #00695c;
                                    border: none;
                                    padding: 4px 8px;
                                    border-radius: 6px;
                                    cursor: pointer;
                                    font-size: 11px;
                                    font-weight: 500;
                                    display: flex;
                                    align-items: center;
                                    gap: 4px;
                                    white-space: nowrap;
                                    height: 26px;
                                ">
                                    <i class="fas fa-trash-alt" style="font-size: 10px;"></i> Удалить
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            html += '</div>';
            problemsList.innerHTML = html;
        }
        
        // Загружаем статистику
        const statsElement = document.getElementById('adminStats');
        if (statsElement) {
            const total = allProblems.length;
            const solved = allProblems.filter(p => p.status === 'solved').length;
            const inProgress = allProblems.filter(p => p.status === 'in_progress').length;
            const newProblems = allProblems.filter(p => p.status === 'new').length;
            const rejected = allProblems.filter(p => p.status === 'rejected').length; // Добавлено
    
            
            statsElement.innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
                    <div style="
                        text-align: center; 
                        background: #e8f4f8; 
                        padding: 12px 8px; 
                        border-radius: 10px; 
                        border: 1px solid #b2dfdb;
                        box-shadow: 0 1px 3px rgba(0, 121, 107, 0.1);
                    ">
                        <div style="font-size: 1.4rem; font-weight: bold; color: #00796b; margin-bottom: 4px;">${total}</div>
                        <div style="font-size: 0.8rem; color: #00796b; font-weight: 500;">Всего проблем</div>
                    </div>
                    <div style="
                        text-align: center; 
                        background: #e8f4f8; 
                        padding: 12px 8px; 
                        border-radius: 10px; 
                        border: 1px solid #b2dfdb;
                        box-shadow: 0 1px 3px rgba(0, 121, 107, 0.1);
                    ">
                        <div style="font-size: 1.4rem; font-weight: bold; color: #00796b; margin-bottom: 4px;">${solved}</div>
                        <div style="font-size: 0.8rem; color: #00796b; font-weight: 500;">Решено</div>
                    </div>
                    <div style="
                        text-align: center; 
                        background: #e8f4f8; 
                        padding: 12px 8px; 
                        border-radius: 10px; 
                        border: 1px solid #b2dfdb;
                        box-shadow: 0 1px 3px rgba(0, 121, 107, 0.1);
                    ">
                        <div style="font-size: 1.4rem; font-weight: bold; color: #00796b; margin-bottom: 4px;">${inProgress}</div>
                        <div style="font-size: 0.8rem; color: #00796b; font-weight: 500;">В работе</div>
                    </div>
                    <div style="
                        text-align: center; 
                        background: #e8f4f8; 
                        padding: 12px 8px; 
                        border-radius: 10px; 
                        border: 1px solid #b2dfdb;
                        box-shadow: 0 1px 3px rgba(0, 121, 107, 0.1);
                    ">
                        <div style="font-size: 1.4rem; font-weight: bold; color: #00796b; margin-bottom: 4px;">${newProblems}</div>
                        <div style="font-size: 0.8rem; color: #00796b; font-weight: 500;">Новые</div>
                    </div>
                </div>
            `;
        }
        
    } catch (error) {
        console.error('Ошибка загрузки данных админа:', error);
    }
}

// ==================== ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ ====================
document.addEventListener('DOMContentLoaded', function() {
    console.log('🟡 DOM загружен, инициализируем приложение...');
    
    try {
        // Инициализируем Firebase
        initializeFirebase();
        
        // Инициализируем карту
        initMap();
        
        // Инициализируем форму
        initializeForm();
        
        // Инициализируем меню пользователя
        initializeUserMenu();
        
        // Загружаем сохраненные фильтры
        loadFilters();
        
        console.log('✅ Приложение инициализировано');
        
    } catch (error) {
        console.error('❌ Ошибка инициализации приложения:', error);
        showNotification('Ошибка загрузки приложения', 'error');
    }
});

// Делаем функции глобально доступными
window.showAuthModal = showAuthModal;
window.hideAuthModal = hideAuthModal;
window.showLoginForm = showLoginForm;
window.showRegisterForm = showRegisterForm;
window.login = login;
window.register = register;
window.logout = logout;
window.addProblem = addProblem;
window.useMyLocation = useMyLocation;
window.centerMap = centerMap;
window.refreshData = refreshData;
window.clearPhoto = clearPhoto;
window.applyFilters = applyFilters;
window.clearFilters = clearFilters;
window.deleteProblem = deleteProblem;
window.changeProblemStatus = changeProblemStatus;
window.deleteProblemAdmin = deleteProblemAdmin;
window.showAdminPanel = showAdminPanel;
window.hideAdminPanel = hideAdminPanel;
window.showAccountSettings = showAccountSettings;
window.hideAccountSettings = hideAccountSettings;

// ==================== ОБРАБОТЧИКИ ОШИБОК ====================
window.onerror = function(message, source, lineno, colno, error) {
    console.error('❌ Глобальная ошибка:', { message, source, lineno, colno, error });
    showNotification('Произошла ошибка в приложении', 'error');
    return false;
};

// ==================== ОФФЛАЙН РЕЖИМ ====================
// Проверяем онлайн статус
window.addEventListener('online', function() {
    console.log('✅ Соединение восстановлено');
    showNotification('Соединение восстановлено', 'success');
    loadProblems();
});

window.addEventListener('offline', function() {
    console.log('⚠️ Потеряно соединение');
    showNotification('Потеряно соединение, работаем офлайн', 'warning');
});

console.log('✅ app.js загружен полностью');




function toggleSidebar() {
  document.getElementById('sidebarPanel').classList.toggle('open');
}
