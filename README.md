# OmniRoute Bridge (v4)

> **In English** — a Manifest V3 browser extension (Chrome + Firefox) that onboards every provider of a
> local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) proxy (`:20128`) from a single popup:
> **web sessions** (HttpOnly cookies *and* bearer tokens, captured via `webRequest`), **API keys** (167),
> and **OAuth** flows (18) — each with an honest live probe, not a lying "valid". The provider catalog is
> **generated from OmniRoute's own source** (`gen-providers.mjs`), so it never drifts.
>
> Credentials are pushed into OmniRoute through its dashboard tab (same-origin, so the admin session
> rides along) — the extension holds no long-lived server secret of its own. Captured web-sessions live
> in `chrome.storage.session` (memory) by default; an opt-in setting mirrors them to disk so they survive
> a browser restart and auto-restore on launch, with a 7-day expiry so dead cookies don't linger. UI is
> localised **ru + en**. Tests: `npm test` (catalog / popup render / service-worker behaviour / i18n).
>
> Built as a companion for OmniRoute's `bulk-web-session` import — see
> [OmniRoute#5843](https://github.com/diegosouzapw/OmniRoute/issues/5843).

---

Расширение (Chrome + Firefox): заводит **всех** провайдеров локального **OmniRoute** (:20128) **в одно окно** —
веб-сессии (куки), API-ключи и OAuth — каждое с **честной живой проверкой**. Без DevTools, без ручного похода в дашборд.

Каталог провайдеров **генерируется прямо из исходника OmniRoute** (`gen-providers.mjs` → `providers.gen.js`),
поэтому не устаревает: после `npm i -g omniroute@latest` достаточно `node gen-providers.mjs`.

## Три вкладки

### 🍪 Веб-сессии (cookie-провайдеры, 22)
Claude · ChatGPT · Gemini · Grok · Perplexity · DeepSeek · Qwen · Kimi · Blackbox · Poe · MS Copilot ·
Doubao/Dola · Venice · v0 · Meta AI · Adapta · Manus · и др.

Userscript (`document.cookie`) **не видит HttpOnly-куки**, а сессии этих сайтов именно на них.
Расширение читает `Cookie` (+ Bearer) из **реального запроса** через `webRequest` и шлёт полный заголовок —
OmniRoute сам извлекает нужное (проверено по его валидаторам). Точная схема захвата на каждого провайдера
(какую куку/`localStorage`/заголовок тянуть) берётся из `open-sse/services/tokenExtractionConfig.ts`.

### 🔑 API-ключи (все apikey-провайдеры OmniRoute)
Все apikey-провайдеры OmniRoute (`src/shared/constants/providers/apikey/*`): от Groq/Cerebras/OpenRouter/
Together/Fireworks/DeepInfra до Azure/Bedrock/Vertex и специализированных (FLUX/Recraft/Firecrawl/Jina…).
Поиск (search-first) + поле вставки + ссылка «где взять ключ» + бейдж free-tier. Паритет add-формы дашборда:
- **provider-specific обязательные поля** — напр. `google-pse-search` требует Search Engine ID (`cx`) (иначе OmniRoute отвергает add); собираются в `providerSpecificData`.
- **⚙ Дополнительно** (опц.) — свой endpoint (base URL, для прокси/self-hosted) + тег маршрутизации.
- **＋ Несколько ключей** — массовое добавление ключей одного провайдера разом (`/api/providers/bulk`).
- **Google AI Studio** — контент-скрипт на `aistudio.google.com` подхватывает видимый ключ `AIza…` и предлагает добавить как `gemini`.

### 🔐 OAuth (18) — все подключаются **прямо в расширении** (паритет с дашбордом)
Единый искомый список, сгруппированный по типу флоу:
- **Device-код (6)** — `github`(Copilot) · `qwen` · `kimi-coding` · `kiro` · `kilocode` · `codebuddy-cn`:
  «Подключить» → код → страница провайдера → фоновый опрос на `chrome.alarms` (уважает `interval`,
  переживает закрытие попапа и засыпание SW).
- **Вход в браузере (7, redirect/PKCE)** — `claude` · `codex` · `gitlab-duo` · `cline` · `qoder` ·
  `zed-hosted` · `antigravity`: «Подключить (вход в браузере)» → расширение берёт auth-URL у OmniRoute
  (`start-callback-server`, иначе `authorize`) и открывает его; callback-сервер/`/callback`-страница
  OmniRoute завершает обмен; расширение ждёт появления соединения провайдера. У `claude`/`codex`/`antigravity`
  также **📦 Импорт .zip** — массовый импорт экспортированных аккаунтов (`zip-extract` → `import-bulk`).
- **Вставка токена (5, import_token)** — `cursor` · `grok-cli` · `trae` · `windsurf` · `zed`:
  поле вставки CLI/сессионного токена → `POST /import-token` → честный живой пробник. У каждого —
  подсказка «где взять токен».

## Честная проверка «реально ли передалось / работает»
Ключевое отличие от прошлых версий: **не доверяем `/api/providers/<id>/test`** — он возвращает `valid`
даже на забаненном upstream-соединении. Вместо этого:
1. **✓ «Добавлено»** — по ответу `201` + `connection.id` (это факт: соединение в БД OmniRoute).
2. **Живой пробник** — реальный `POST /v1/chat/completions` (1 токен) через модель `<slug>/…`:
   🟢 работает (200) · 🔴 не работает (текст ошибки upstream) · ⚪ проверить не удалось (нет моделей/сети).
   Кнопка **«Проверить»** повторяет пробу в любой момент.

## Что ещё умеет попап
- **Живые соединения** — под каждым провайдером и в футере: сколько соединений уже в OmniRoute и их здоровье (🟢/🔴, читает `/api/providers`).
- **«🔄 Обновит vs ➕ Добавит»** — карточка заранее говорит (и красит кнопку), обновит ли повторная отправка существующее соединение или заведёт новое, сверяясь с именами реальных соединений. Реагирует на имя аккаунта. Дедуп у OmniRoute — по `(провайдер, имя)`; расширение всегда добавляет в имя стабильный `· <accountId>`, поэтому тот же аккаунт → обновление, другой → новое.
- **«Отправить все»** — разом добавить все захваченные web-сессии (с предсказанием «N обновит · M создаст»); **«🔄 Обновить только упавшие»** — перепослать лишь те, чьё соединение сейчас мёртвое; **бейдж на иконке** = сколько готово. У каждой карточки — «✕» убрать захваченную сессию.
- **«Проверить все»** — батч-health по всем соединениям (модели тянутся один раз): 🟢 работает · 🔴 нет · ⚪ не проверено. Результаты пробника **запоминаются** между открытиями (старше 10 мин помечаются «проверено N назад»). **Фоновый health-sweep** (alarm, раз в ~15 мин) переопрашивает известные соединения и **красит иконку красным с числом умерших** + шлёт desktop-уведомление о НОВОЙ поломке.
- **OAuth device-flow** — крупный копируемый код; Enter отправляет; при офлайне `127.0.0.1:20128` кнопки блокируются. Опрос уважает `interval` провайдера (GitHub: 5с; при `slow_down` — backoff), поэтому авторизация реально завершается.
- **⚠ Требуют внимания** — **глобальная** секция (видна на всех вкладках) со всеми забаненными/сломанными соединениями И теми, кто провалил честный живой пробник (не только по лживому `testStatus`): web → «Открыть сайт» + «Удалить»; device-flow OAuth → «Переподключить»; всё → «Удалить» (+ «Удалить все» одним конфирмом). Проблемная карточка красная + бейдж `⚠ N`.
- **⚙ Все соединения** — раскрывающийся менеджер (та же глобальная секция, свёрнут по умолчанию): ВСЕ соединения OmniRoute, сгруппированные по провайдеру, с быстрым **переименованием / вкл-выкл маршрутизации / удалением** любого — не только сломанного (паритет с управлением дашборда). Массовое администрирование 50+ остаётся в дашборде — это правки на месте, без ухода из попапа. Действия переиспользуют тот же `PATCH`/`DELETE /api/providers/<id>`, что и секция «Требуют внимания».

## Иконка и тема
Иконки (`icons/icon{16,32,48,128}.png`) генерятся `python make-icons.py [accent_top accent_bottom]` (роутинг-хаб на градиенте). Палитра — «Сланец» (сдержанный сине-серый акцент), светлая/тёмная авто по системе; логотип и иконка в цвете акцента.

## Как работает отправка
POST `/api/providers` (create only) выполняется **изнутри вкладки дашборда** (`scripting.executeScript`
`world:'MAIN'`) → same-origin → HttpOnly admin-сессия (обходит `SameSite=Lax`). Имена соединений уникальны
по JWT-id аккаунта (`omniAccountId`) → N аккаунтов = N соединений (OmniRoute UPSERT-ит по `provider+name`).
Живой пробник шлёт запросы на открытый локально `/v1` напрямую из service-worker'а (без сессии дашборда).

## Установка
⚠️ Chrome (MV3) требует `background.service_worker` и **отвергает** `background.scripts`; Firefox — наоборот
(service_worker отключён, нужен `background.scripts`). Один манифест на оба **невозможен** → две сборки:
`node build.mjs` → `build/chrome/` и `build/firefox/`.

**Chrome/Edge:** `chrome://extensions` → Режим разработчика → **Загрузить распакованное** → корень папки
(там `service_worker`) **или** `build/chrome/`. После правок — **⟳ Reload**.

**Firefox** (FF **128+**, из-за `world:'MAIN'`): `about:debugging#/runtime/this-firefox` → **Загрузить
временное дополнение** → **`build/firefox/manifest.json`** (НЕ корень — там `service_worker`, Firefox его
отвергнет). Если после загрузки пишет «127.0.0.1:20128 не запущен» — проверь `about:addons` → OmniRoute Bridge
→ **Разрешения** → доступ к `localhost` должен быть выдан (в Firefox MV3 host-права опциональны).
(Постоянная установка — подписанный `.xpi` через `pwsh -File pack-xpi.ps1` → AMO, либо Developer/Nightly с
`xpinstall.signatures.required=false`.)

**Открепить в окно:** кнопка ▭ в шапке открывает попап в отдельном окне — не закрывается при переключении вкладок.

## Настройки и приятности
Шестерёнка в шапке: фоновая **проверка здоровья** (вкл/выкл + интервал) красит иконку и шлёт уведомление,
когда соединение умирает; **уведомления**; **тема** (системная/светлая/тёмная); «проверить всё сейчас»;
экспорт списка соединений в JSON; сброс статусов. Клавиши: **Alt+Shift+O** (открыть попап), **1/2/3** (вкладки),
**/** (поиск), **Esc** (закрыть настройки).

## Регенерация каталога и проверки
```bash
node gen-providers.mjs   # авто-локация OmniRoute: OMNI_ROOT → npm global → <SCRIPTS_ROOT>\External\OmniRoute (git-clone)
node build.mjs           # пересобрать build/chrome и build/firefox
npm test                 # инварианты каталога + headless DOM-рендер (0 JS-ошибок), без браузера
npm run check            # node --check всех .js
```
`gen-providers.mjs` парсит три реестра OmniRoute (web/apikey/oauth) — **whether npm-installed OR a git-clone+rebuild
under `<SCRIPTS_ROOT>\External\OmniRoute`** — пишет `providers.gen.js` и синхронизирует `host_permissions` манифеста.
Каталог **отслеживает установленную версию OmniRoute** (счётчики дрейфуют — это норма). `providers.js` — тонкий
адаптер (RegExp хостов + credential-хелперы). `test-render.mjs` (devDep `linkedom`) — воспроизводимая проверка
рендера без браузера, fallback когда Playwright/pw-firefox недоступны.

## Ограничения / безопасность
- Вкладка дашборда OmniRoute должна быть **открыта и залогинена** (расширение одалживает её сессию, ничего не хранит).
- Куки живут часы-дни; отвалилось → перезайди на сайт, отправь сообщение, «Отправить» снова. Захват старше ~6ч помечается жёлтым «возможно устарело».
- API-ключи и куки уходят **только** на `:20128`. Токены/ключи/OAuth-коды кэшируются в **`chrome.storage.session`** — в памяти, стираются при закрытии браузера.
- ⚠️ **Исключение — захваченные веб-сессии (`cap_*`).** При настройке **«Хранить сессии на диске»** (по умолчанию **ВКЛ**) они зеркалируются в `chrome.storage.local`, то есть **ложатся на диск профиля браузера и переживают перезапуск**. Это осознанный размен: без него `chrome.storage.session` стирается при закрытии браузера, на утреннем старте восстанавливать нечего, и провайдеров приходится пере-импортировать руками (`restartRecovery` именно этим и лечит). Выключи настройку — секреты останутся только в памяти, а уже сохранённые диск-копии будут стёрты. Не-секреты (вердикты пробника, настройки) — в `.local`.
- Перед первой отправкой кредов расширение проверяет, что на `:20128` действительно OmniRoute (форма ответа `/api/providers`), чтобы не влить креды случайному локальному процессу на том же порту.
- Host-права сужены до точных провайдер-хостов; общие мульти-тенант базы (`google.com`, `microsoft.com`, `cloud.microsoft`, `tencent.com`) НЕ вайлдкардятся (иначе дали бы доступ к Gmail/Outlook/Teams) — только точный хост провайдера.
- Каталог берётся из исходника as-is; отдельные web-слаги OmniRoute может отвергнуть на добавлении (`chatglm-web`/
  `duckduckgo-web`/`t3-chat-web` исторически) — тогда пробник честно покажет 🔴 с текстом ошибки, а не тихий успех.
