/**
 * 讀取外部 JSON API 或靜態檔的共用流程：逾時、只對暫時性錯誤退避重試、把 HTTP 狀態轉成可辨識的錯誤。
 */

const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_ATTEMPT_COUNT = 3;
const RETRY_BASE_DELAY_MILLISECONDS = 2_000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MINIMUM = 500;

/** 可重試的錯誤：逾時、網路中斷、HTTP 429 與 5xx。 */
export class TransientFetchError extends Error {}

/** 不重試的 HTTP 錯誤，保留狀態碼讓呼叫端決定訊息。 */
export class HttpStatusError extends Error {
  /**
   * @param {string} error_message 訊息
   * @param {number} http_status HTTP 狀態碼
   */
  constructor(error_message, http_status) {
    super(error_message);
    this.http_status = http_status;
  }
}

/**
 * @typedef {object} RequestOptions
 * @property {string} source_label 錯誤訊息裡的來源名稱，例如「AEMO 儀表板 API」
 * @property {typeof fetch} [fetch_function] 預設為瀏覽器的 fetch
 * @property {(milliseconds: number) => Promise<void>} [sleep_function] 退避等待
 * @property {number} [timeout_milliseconds] 單次請求逾時
 */

/**
 * 送出請求並解析 JSON，遇到暫時性錯誤以 2 秒、4 秒退避，最多 3 次。
 *
 * @param {string} request_url 網址
 * @param {RequestInit} request_init fetch 的設定（不含 signal）
 * @param {RequestOptions} request_options 來源名稱與可替換的實作
 * @returns {Promise<unknown>} 原始 JSON
 * @throws {TransientFetchError | HttpStatusError | Error} 重試用盡或遇到不可重試的錯誤
 */
export async function fetch_json_with_retry(request_url, request_init, request_options) {
  return fetch_with_retry(request_url, request_init, request_options, (http_response) => http_response.json());
}

/**
 * 送出請求並取回文字內容（例如 CSV 檔），重試規則與 `fetch_json_with_retry` 相同。
 *
 * @param {string} request_url 網址
 * @param {RequestInit} request_init fetch 的設定（不含 signal）
 * @param {RequestOptions} request_options 來源名稱與可替換的實作
 * @returns {Promise<string>} 回應內文
 * @throws {TransientFetchError | HttpStatusError | Error} 重試用盡或遇到不可重試的錯誤
 */
export async function fetch_text_with_retry(request_url, request_init, request_options) {
  return fetch_with_retry(request_url, request_init, request_options, (http_response) => http_response.text());
}

/**
 * 重試迴圈：只有 `TransientFetchError` 會重試。
 *
 * @param {string} request_url 網址
 * @param {RequestInit} request_init fetch 設定
 * @param {RequestOptions} request_options 來源名稱與可替換的實作
 * @param {(http_response: Response) => Promise<unknown>} read_body 讀取成功回應的內文
 * @returns {Promise<unknown>} 內文
 */
async function fetch_with_retry(request_url, request_init, request_options, read_body) {
  const fetch_function = request_options.fetch_function ?? globalThis.fetch.bind(globalThis);
  const sleep_function = request_options.sleep_function ?? wait_milliseconds;
  const timeout_milliseconds = request_options.timeout_milliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  for (let attempt_number = 1; ; attempt_number++) {
    try {
      return await request_once(request_url, request_init, { fetch_function, timeout_milliseconds, source_label: request_options.source_label, read_body });
    } catch (request_error) {
      const is_last_attempt = attempt_number >= MAXIMUM_ATTEMPT_COUNT;
      if (!(request_error instanceof TransientFetchError) || is_last_attempt) throw request_error;
      await sleep_function(RETRY_BASE_DELAY_MILLISECONDS * 2 ** (attempt_number - 1));
    }
  }
}

/**
 * 單次請求，並把錯誤分成可重試與不可重試。
 *
 * @param {string} request_url 網址
 * @param {RequestInit} request_init fetch 設定
 * @param {{fetch_function: typeof fetch, timeout_milliseconds: number, source_label: string, read_body: (http_response: Response) => Promise<unknown>}} request_settings fetch 實作、逾時、來源名稱與內文讀法
 * @returns {Promise<unknown>} 內文
 */
async function request_once(request_url, request_init, request_settings) {
  const abort_controller = new AbortController();
  const timeout_handle = setTimeout(() => abort_controller.abort(), request_settings.timeout_milliseconds);
  const source_label = request_settings.source_label;
  let http_response;
  try {
    http_response = await request_settings.fetch_function(request_url, { ...request_init, signal: abort_controller.signal });
  } catch (network_error) {
    throw new TransientFetchError(`連線 ${source_label} 失敗：${network_error.message}`, { cause: network_error });
  } finally {
    clearTimeout(timeout_handle);
  }
  if (http_response.status === HTTP_TOO_MANY_REQUESTS || http_response.status >= HTTP_SERVER_ERROR_MINIMUM) {
    throw new TransientFetchError(`${source_label} 回應 HTTP ${http_response.status}`);
  }
  if (!http_response.ok) throw new HttpStatusError(`${source_label} 回應 HTTP ${http_response.status}`, http_response.status);
  return request_settings.read_body(http_response);
}

/**
 * 等待指定毫秒。
 *
 * @param {number} milliseconds 等待時間
 * @returns {Promise<void>}
 */
function wait_milliseconds(milliseconds) {
  return new Promise((resolve_wait) => setTimeout(resolve_wait, milliseconds));
}
