# OmniRoute Bridge (v4)

> **In English** — a Manifest V3 companion for a local [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
> proxy at `http://127.0.0.1:20128`, with Chrome and Firefox packages and a **ru + en** interface.
> Setup notes supplied by OmniRoute remain in their original language.
> The searchable directory covers **394 unique registered providers across all ten `_PROVIDER_SECTIONS`**
> at OmniRoute commit `e3c1531afd07d5e06f7ffab658584a7ae2e3627e`. Every entry has setup guidance and a
> dashboard action. Inline API-key forms and OAuth actions cover supported setup paths; web-session
> capture is enabled only for **source-reviewed Cookie/Bearer formats**. Other setups, including
> ChatGPT browser storage-state imports and provider-specific cloud configuration, open the dashboard.
> The generated lists contain **37 web entries, 313 API-key capability entries, 32 OAuth routes** and
> **24 other-only entries**. These lists overlap; automatic setup covers a narrower set of supported paths.
> The web entries use **15 Cookie, 6 Bearer-token and 16 dashboard modes**.
> **Capability coverage is not live-account verification.** A chat probe checks an available provider/model
> route; it does not independently verify every account or non-chat service.
> OmniRoute identifies language-model services as `llm` in `serviceKinds`; search/audio need service-specific checks.
>
> The catalog is AST-read from the selected OmniRoute source, without executing upstream modules.
> The committed [`provider-coverage.json`](provider-coverage.json) records the revision, source locations,
> SHA-256 hashes and per-provider capabilities. Regeneration is explicit: updating OmniRoute alone does
> not update this extension's catalog. For development, run `npm ci`; generation requires a local OmniRoute
> source checkout. Use `OMNI_ROOT=/path/to/OmniRoute npm run gen -- --ref <commit>` and append `--check`
> to compare generated artifacts without rewriting them. The selected commit must exist in that checkout.
>
> Provider administration runs through the logged-in OmniRoute dashboard tab using its same-origin admin
> session; the extension holds no long-lived server admin secret. Captured sessions use
> `chrome.storage.session` **and, by default, are mirrored to disk in `chrome.storage.local`**.
> Persistence is **ON by default**, with restart recovery and a 7-day expiry. Turning it off removes the
> disk copies and keeps captures in memory only.
>
> **This fork branch is usable while upstream review is pending:** load the repository root unpacked in
> Chrome/Edge, or run `npm run build` for `build/chrome/` and `build/firefox/`. `npm test` runs offline suites.
> The opt-in `npm run test:browser` command below takes explicit Chromium/Playwright paths and a new output
> directory; it uses fresh isolated profiles and synthetic fixtures with no forwarding to real providers.
> **External accounts and Firefox UI remain unverified.**
>
> Built as a companion for OmniRoute's `bulk-web-session` import — see
> [OmniRoute#5843](https://github.com/diegosouzapw/OmniRoute/issues/5843).

---

Расширение для локального **OmniRoute** (`http://127.0.0.1:20128`): единый каталог, подсказки настройки,
подключение поддерживаемых веб-сессий, API-ключей и OAuth, управление соединениями и chat-пробник.
Интерфейс — **ru + en**; исходные подсказки провайдеров отображаются в том виде, в котором они заданы upstream.

## Полный каталог и границы покрытия

Включены **все 394 уникальных провайдера**, зарегистрированные в десяти секциях `_PROVIDER_SECTIONS`
в `src/shared/constants/providers.ts` на коммите OmniRoute **`e3c1531afd07d5e06f7ffab658584a7ae2e3627e`**.
Это зафиксированный срез исходников, а не обещание совпадения с любой установленной версией OmniRoute.

| Реестр upstream | Провайдеров |
| --- | ---: |
| `NOAUTH_PROVIDERS` | 10 |
| `OAUTH_PROVIDERS` | 31 |
| `APIKEY_PROVIDERS` | 262 |
| `WEB_COOKIE_PROVIDERS` | 37 |
| `LOCAL_PROVIDERS` | 15 |
| `SEARCH_PROVIDERS` | 21 |
| `AUDIO_ONLY_PROVIDERS` | 12 |
| `UPSTREAM_PROXY_PROVIDERS` | 2 |
| `CLOUD_AGENT_PROVIDERS` | 3 |
| `SYSTEM_PROVIDERS` | 1 |
| **Всего уникальных** | **394** |

Раздел **«Каталог»** ищет по имени, slug, категории и подсказкам; показывает доступные ссылки, инструкции
upstream, параметры сервиса и ссылку на исходник выбранной ревизии. У каждой записи есть действие
**настройки в дашборде**, включая local/no-auth/system и сложные облачные интеграции.
Там, где расширение поддерживает настройку, доступны также форма ключа, OAuth или захват сессии.
Списки возможностей в этом срезе: **37 web-записей, 313 API-key-записей, 32 OAuth-маршрута
и 24 прочие записи (`other`)**. Они могут пересекаться: провайдер с двумя способами авторизации остаётся
одной записью каталога. `other` содержит записи вне первых трёх списков. Охват автоматического
подключения меньше: конкретные встроенные действия зависят от провайдера.

### 🍪 Веб-сессии: захват по проверенному формату

`document.cookie` не видит HttpOnly-куки. Расширение использует браузерные API, в том числе `webRequest`,
для захвата сессий на разрешённых хостах. **Формат зависит от провайдера:** полный `Cookie`, значение
конкретной куки или Bearer-токен. Например, рецепты есть для Claude, Gemini, Grok, Perplexity и DeepSeek.

Рецепты находятся в [`provider-capabilities.mjs`](provider-capabilities.mjs) и сверяются с исходниками
валидаторов/исполнителей выбранной версии OmniRoute. Для cookie-рецептов проверяются необходимые группы
кук; одного случайного Cookie-заголовка недостаточно. `open-sse/services/tokenExtractionConfig.ts` служит
дополнительным источником метаданных и инструкций, но наличие записи в нём само по себе не включает захват.
В зафиксированном срезе 37 web-записей используют **15 cookie-, 6 Bearer- и 16 dashboard-режимов**.

Если `chrome.cookies.getAll` возвращает список без полного пригодного кандидата — пустой, только
с аналитическими cookie или неполный — резервный `chrome.cookies.get` ищет обязательные cookie из
проверенного рецепта по тому же точному URL захвата и в том же хранилище. Сначала проверяется цельное
имя, а при отсутствии непустого значения — до 16 последовательных непустых частей `.0`–`.15`
(с проверкой `.16` на переполнение). Это позволяет находить cookie родительского домена, сохраняя
host-права на точные хосты. Используется либо полный кандидат из перечисления, либо отдельный полный
именной кандидат в unpartitioned-контексте; их результаты не смешиваются. Кандидаты разных URL,
хранилищ и first-party/partition-контекстов не объединяются. Общий бюджет поиска — 4 с, на запрос —
не более 800 мс; поздние результаты игнорируются. Подробности — [TESTING.md](TESTING.md#cookie-discovery-bounds).

Если проверенного рецепта нет или его исходные подтверждения изменились, карточка предлагает **дашборд**.
Например, `chatgpt-web` требует Playwright storage-state JSON и привязки браузера к соединению, а
`copilot-m365-web` — специального входа Microsoft. Настройки с дополнительными полями, browser state,
local storage или IndexedDB передаются в соответствующий мастер OmniRoute.

### 🔑 API-ключи

Поиск, доступные подсказки upstream, ссылка «где взять ключ» и сведения о free-tier помогают выбрать
провайдера. **Встроенная форма** доступна для поддерживаемых способов настройки ключом:
- **Обязательные дополнительные поля** — например, Search Engine ID (`cx`) для `google-pse-search`
  и Account ID для `cloudflare-ai`; передаются в `providerSpecificData`.
- **⚙ Дополнительно** (необязательно) — свой endpoint (base URL) и тег маршрутизации.
- **＋ Несколько ключей** — `/api/providers/bulk` для провайдеров, которым upstream разрешает этот путь.
- **Google AI Studio** — контент-скрипт на `aistudio.google.com` подхватывает видимый ключ `AIza…`
  и предлагает добавить его как `gemini`.

Для Azure, Bedrock, Vertex и других интеграций со специальной ресурсной, проектной или нативной
конфигурацией открывается **дашборд OmniRoute**. Доступность записи в каталоге не означает, что обычная
форма ключа заменяет все поля её настройки.
Если исходники помечают ключ необязательным, встроенная форма допускает пустой ключ;
обязательные дополнительные поля всё равно проверяются.

### 🔐 OAuth

Типы флоу читаются из OAuth-реестра upstream. Встроенные действия доступны там, где поддержаны
соответствующие маршруты OmniRoute:
- **Device-код** — код и страница провайдера, затем фоновый опрос на `chrome.alarms` с учётом `interval`
  и `slow_down`; опрос рассчитан на закрытие попапа и перезапуск service worker.
- **Вход в браузере (redirect/PKCE)** — расширение запускает callback-сервер OmniRoute и открывает auth-URL.
  Callback сохраняет параметры; обмен токена и запись соединения выполняет
  `POST /api/oauth/<provider>/poll-callback`. Успех подтверждается ответом `success: true` с `connection.id`,
  в том числе при повторном входе в существующий аккаунт. Для `claude`, `codex` и `antigravity` предусмотрен также
  **📦 Импорт .zip** экспортированных аккаунтов (`zip-extract` → `import-bulk`).
- **Вставка токена (`import_token`)** — импорт через поддерживаемый маршрут `/import-token`.

Флоу со специальными параметрами, неподдержанным callback или способом импорта открывают **дашборд**.
Конкретный выбор `inline`/`dashboard` отражён в `provider-coverage.json` и в действиях карточки.

## Что означает «добавлено» и что проверяет пробник

**Подтверждение записи** (ответ OmniRoute с `connection.id`) означает, что соединение сохранено.
Статус `valid` из `/api/providers/<id>/test` сам по себе не доказывает работоспособность сервиса.

**Живой chat-пробник** выбирает доступную модель `<slug>/…` из `/v1/models` и выполняет короткий
`POST /v1/chat/completions`: 🟢 успешный ответ · 🔴 ошибка запроса/авторизации · ⚪ проверить не удалось.
Нет моделей, сеть/таймаут, rate limit и сохраняющаяся ошибка 5xx дают неопределённый результат.
Кнопка **«Проверить»** повторяет запрос; в обычной работе это реальное обращение через OmniRoute.

Результат относится к **маршруту провайдера и модели**, а не к независимой проверке каждого аккаунта
в пуле. Chat-проба не проверяет основную функцию search/audio и других не-chat сервисов — для них нужна
профильная проверка в OmniRoute. Покрытие каталога и исходников **не является проверкой живых аккаунтов**.
В метаданных upstream языковые модели обозначаются значением **`llm` в `serviceKinds`**, а не `chat`;
название HTTP-маршрута `/v1/chat/completions` не меняет это значение реестра.
Провайдеры с `llm` допускаются к chat-пробе. При чтении `/v1/models` сохраняются `type` и
`supported_endpoints`; явно не-chat и Responses-only модели исключаются из выбора для чата и пробника.

## Что ещё умеет попап

- **Соединения OmniRoute** — количество и заявленные сервером статусы из `/api/providers`, дополненные
  сохранёнными результатами пробника.
- **«🔄 Обновит / ➕ Добавит»** — предварительная оценка по именам существующих соединений. Имя веб-сессии
  содержит идентификатор из JWT или хеш учётных данных; при изменении последних хеш может измениться.
- **«Отправить все»** и **«Обновить только упавшие»** — отправка доступных захваченных веб-сессий;
  бейдж показывает готовые захваты, отдельную сессию можно убрать кнопкой «✕».
- **«Проверить все»** — последовательные пробы по провайдерам с сохранением результатов между открытиями.
  Фоновый health-sweep (по умолчанию примерно раз в 15 минут) обновляет статусы и может показать красный
  бейдж и уведомление о новой проблеме. Его можно настроить или выключить.
- **«Требуют внимания»** — проблемные соединения и неудачные пробы; доступные действия зависят от способа
  настройки провайдера, включая переход на сайт, переподключение через дашборд и удаление.
- **«Все соединения»** — переименование, включение/выключение маршрутизации и удаление через
  `PATCH`/`DELETE /api/providers/<id>`. Расширенная конфигурация остаётся в дашборде.

## Как работает отправка

Административные запросы, включая `POST /api/providers`, выполняются **из вкладки дашборда**
(`scripting.executeScript`, `world:'MAIN'`) с её same-origin admin-сессией. Расширению не нужен отдельный
долгоживущий административный секрет. Дашборд должен быть открыт и авторизован для этих операций.
Chat-пробник обращается к локальному `/v1` напрямую там, где это разрешает браузер, либо через вкладку
дашборда. Дальнейшие запросы к провайдерам выполняет OmniRoute.

## Установка из этой ветки форка

**Веткой `fix/provider-catalog-20261120` можно пользоваться, пока изменения ожидают upstream-review.**
Она основана на runtime-коммите ниже; готовые файлы расширения находятся в корне и не требуют генерации.

Runtime/packaging: открытый [PR #2](https://github.com/danscMax/omniroute-cookie-bridge/pull/2),
ветка `fix/bridge-runtime-results-20261120`, коммит `c292281` — переносимый браузерный runner и loopback-права.

**Chrome/Edge:** `chrome://extensions` → Режим разработчика → **Загрузить распакованное** → корень
репозитория **или** `build/chrome/` после сборки. После правок — **⟳ Reload**.

Для разработки установите зависимости и соберите варианты:

```bash
npm ci
npm run build
```

Сборщик создаёт **`build/chrome/`** с `background.service_worker` и **`build/firefox/`** с
`background.scripts`. Корневой манифест предназначен для Chrome.

**Firefox 128+:** `about:debugging#/runtime/this-firefox` → **Загрузить временное дополнение** →
**`build/firefox/manifest.json`**. Если локальный OmniRoute недоступен, проверьте `about:addons` →
OmniRoute Bridge → **Разрешения** → доступ к `http://127.0.0.1/*`.
Для постоянной установки используется подписанный `.xpi`; упаковка — `pwsh -File pack-xpi.ps1`.
**Интерфейс Firefox в рамках этих проверок не проверен в живом браузере.**

**Открепить в окно:** кнопка ▭ в шапке открывает попап в отдельном окне, которое не закрывается
при переключении вкладок.

## Настройки, иконка и тема

В настройках доступны фоновая проверка здоровья и её интервал, уведомления, хранение сессий на диске,
тема (системная/светлая/тёмная), проверка сейчас, экспорт списка соединений в JSON и сброс статусов.
Клавиши: **Alt+Shift+O** — открыть попап, **1–8** — разделы, **/** — поиск по каталогу.

Иконки (`icons/icon{16,32,48,128}.png`) генерируются `python make-icons.py [accent_top accent_bottom]`.
Палитра — «Сланец» (сдержанный сине-серый акцент), светлая/тёмная тема по системе.

## Регенерация каталога и доказательства покрытия

Для генерации нужны **dev-зависимости (`npm ci`) и локальная копия исходников OmniRoute** с реестрами
в `src/` и `open-sse/`. Установленный npm-пакет подходит только если содержит эти исходники;
одного собранного серверного bundle недостаточно. Для воспроизводимого `--ref <commit>` также нужны
Git-репозиторий OmniRoute и выбранный коммит в его локальной истории.

Укажите исходники явно через `OMNI_ROOT`. Пример для зафиксированной ревизии (Bash):

```bash
npm ci
OMNI_ROOT="/path/to/OmniRoute" npm run gen -- --ref e3c1531afd07d5e06f7ffab658584a7ae2e3627e
OMNI_ROOT="/path/to/OmniRoute" npm run gen -- --ref e3c1531afd07d5e06f7ffab658584a7ae2e3627e --check
npm run build
```

В PowerShell сначала задайте `$env:OMNI_ROOT = 'C:\path\to\OmniRoute'`, затем запускайте
`npm run gen -- --ref <commit>` (для сравнения — с `--check`). Генератор читает указанный коммит через
`git show`, не переключая checkout. Без `--ref` используются текущие файлы исходников; поле ревизии
в provenance тогда не закреплено. Автопоиск без `OMNI_ROOT` проверяет npm-global и известные каталоги
исходников, в том числе `<SCRIPTS_ROOT>/External/OmniRoute`; явный путь устраняет неоднозначность.

[`gen-providers.mjs`](gen-providers.mjs) использует [`provider-source.mjs`](provider-source.mjs):
TypeScript AST-разбор следует импортам и раскрывает **все `_PROVIDER_SECTIONS`**, не исполняя модули
OmniRoute. Из upstream берутся категории, метаданные, OAuth-флоу и инструкции извлечения.
[`provider-capabilities.mjs`](provider-capabilities.mjs) задаёт проверенные возможности расширения;
неизвестный рецепт или изменившееся подтверждение переводит веб-настройку в дашборд.

Генерация обновляет три файла:
- **`providers.gen.js`** — каталог и возможности для расширения; `providers.js` адаптирует их для UI и фона.
- **`provider-coverage.json`** — хранимое в репозитории свидетельство покрытия: общий итог и секции,
  запись на каждый provider slug, исходные файл/строка, режимы настройки и причины/ссылки для захвата,
  а также исключённые записи extraction-конфига, не входящие в web-реестр.
- **`manifest.json`** — host-права, соответствующие разрешённым хостам захвата, плюс фиксированные хосты
  локального OmniRoute и Google AI Studio.

В `provenance` записаны Git-ref, **SHA-256 каждого прочитанного исходного файла**, общий хеш списка
исходников и `capabilitiesSha256` файла рецептов. Это позволяет сопоставить каталог с использованными
исходниками и правилами расширения. **Хеши и coverage-файл подтверждают происхождение и классификацию,
а не успешный вход в реальные аккаунты.**

`--check` сравнивает все три результата с файлами репозитория, ничего не перезаписывает и завершает
проверку с ошибкой при расхождении. Обновление `omniroute` само по себе каталог не меняет: для другой
версии нужно выбрать её исходники/коммит, регенерировать, проверить изменения и пересобрать варианты.

## Проверки

```bash
npm ci
npm test
npm run check
```

`npm test` включает **офлайн-наборы**: чтение исходников/генератор, инварианты каталога, DOM-рендер
попапа, поведение фона/runtime, поиск cookie, упаковку и i18n. `npm run test:cookies` отдельно запускает
`test-cookie-discovery.mjs` на синтетических cookie. DOM-проверки используют dev-зависимость `linkedom`.
`npm run check` проверяет синтаксис скриптов. Эти команды не являются проверкой внешних аккаунтов.

Отдельно, по явному запуску, доступен браузерный runner с указанными вами Chromium и установленным
пакетом Playwright. Замените заполнители путями; каталог вывода должен быть **новым**:

```bash
npm run test:browser -- --executable "<Chromium-path>" --playwright "<Playwright-package-directory>" --output "<new-output-directory>"
```

По умолчанию проверяется корневой пакет. Чтобы проверить сборку Chrome, сначала выполните
`npm run build`, затем добавьте к команде **`--package build/chrome`**.
Runner использует **свежие изолированные профили и синтетические fixtures без форвардинга к реальным
провайдерам**; результаты сохраняются в выбранном каталоге вывода. Он проверяет поведение расширения
в Chromium на моделируемых ответах. **Внешние аккаунты и Firefox UI остаются непроверенными.**

Сценарии и ограничения — в [TESTING.md](TESTING.md).

## Хранение сессий и ограничения

- Для административных операций нужна открытая авторизованная вкладка дашборда OmniRoute.
  Её admin-сессия используется для same-origin запросов; отдельный admin-токен расширение не хранит.
- Расширение отправляет импортируемые ключи и сессии локальному OmniRoute на `127.0.0.1:20128`.
  Кэш API-ключей, OAuth-кодов и токенов использует `chrome.storage.session` (память).
- **Захваченные веб-сессии (`cap_*`) по умолчанию также сохраняются на диск.** Настройка
  **«Хранить сессии на диске» — ВКЛ по умолчанию**: копии в `chrome.storage.local` переживают перезапуск
  и восстанавливаются при запуске с ограничением возраста **7 дней**. Выключение настройки удаляет
  диск-копии и оставляет захваты только в памяти. Настройки и результаты пробника хранятся в `.local`.
- Срок хранения не продлевает жизнь cookie/Bearer-токена. Для поддерживаемого захвата при истечении
  сессии войдите на сайт, выполните действие, создающее авторизованный запрос, и отправьте сессию снова;
  для остальных способов используйте мастер дашборда. Захват старше примерно 6 часов помечается устаревшим.
- Перед отправкой расширение проверяет ожидаемую форму ответа `/api/providers` локального сервера.
  Ошибка добавления или неопределённый результат пробы не считаются успешным подключением.
- Host-права захвата ограничены точными проверенными хостами. Общие домены `google.com`, `microsoft.com`,
  `cloud.microsoft`, `tencent.com` не превращаются в wildcard-доступ ко всем их сервисам.
