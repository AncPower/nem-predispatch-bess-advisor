/**
 * CSV 單列拆欄（純計算），支援雙引號與跳脫的雙引號。
 */

/**
 * 拆一列 CSV。
 *
 * @param {string} csv_line 一列文字
 * @returns {string[]} 欄位
 */
export function split_csv_line(csv_line) {
  const row_cells = [];
  let current_cell = "";
  let inside_quotes = false;
  for (let character_index = 0; character_index < csv_line.length; character_index++) {
    const current_character = csv_line[character_index];
    if (inside_quotes && current_character === '"' && csv_line[character_index + 1] === '"') {
      current_cell += '"';
      character_index++;
    } else if (current_character === '"') {
      inside_quotes = !inside_quotes;
    } else if (current_character === "," && !inside_quotes) {
      row_cells.push(current_cell);
      current_cell = "";
    } else {
      current_cell += current_character;
    }
  }
  row_cells.push(current_cell.replace(/\r$/, ""));
  return row_cells;
}
