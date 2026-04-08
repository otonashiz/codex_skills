---
name: flomo-convert
description: 将 Flomo 导出的 HTML 笔记文件转换为 Markdown 格式。当用户说"转换 flomo"、"flomo 转 md"、"转换笔记"或使用 /flomo-convert 命令时触发。自动查找 HTML 文件，提取时间范围，生成格式化的 Markdown 输出。
tools: Bash, Glob, Read
---

# Flomo HTML 转 Markdown

将 Flomo 导出的 HTML 笔记文件转换为 Markdown 格式，自动处理文件查找、时间提取和格式转换。

## 工作流程

### 1. 查找 HTML 文件

使用 Glob 工具在当前目录查找 HTML 文件：
- 文件名包含"笔记"或"flomo"
- 扩展名为 `.html`

如果找到多个文件，列出所有文件并让用户选择要转换哪一个。如果只找到一个，直接使用。

如果用户在命令中提供了具体文件名（如 `/flomo-convert 文件名.html`），直接使用该文件。

### 2. 提取时间范围

读取 HTML 文件，提取第一条和最后一条笔记的时间：
- 时间格式：`YYYY-MM-DD HH:MM:SS`（如 `2026-03-02 21:49:13`）
- 只需要日期部分（YYYY-MM-DD）

生成输出文件名格式：`YYYYMMDD-YYYYMMDD.md`
- 例如：第一条笔记是 2025-02-22，最后一条是 2025-03-02
- 输出文件名：`20250222-20250302.md`

### 3. 执行转换

优先使用当前 skill 自带的脚本 `scripts/convert_flomo_html.py` 进行转换，不要依赖当前项目里的 `convert_html_to_md.py`。

执行前先检查依赖是否安装，如未安装则自动安装：

```bash
python3 -c "import bs4" 2>/dev/null || pip3 install beautifulsoup4 --break-system-packages -q
```

脚本路径按 skill 目录解析，优先使用当前 skill 目录下的相对路径。如果需要显式绝对路径，默认是 `~/.codex/skills/flomo-convert/scripts/convert_flomo_html.py`。

使用方式：

```bash
python3 ~/.codex/skills/flomo-convert/scripts/convert_flomo_html.py \
  "输入文件.html" \
  "输出文件.md"
```

### 4. 显示结果

转换完成后，读取生成的 Markdown 文件，统计笔记条数（查找 `## 笔记` 的数量），并向用户显示：

```
✅ 转换完成！
- 输入文件：otonashi.z的笔记20250222.html
- 输出文件：20250222-20250302.md
- 笔记条数：156 条
```

## 错误处理

**找不到 HTML 文件**：
```
❌ 找不到 HTML 文件
请确保当前目录有包含"笔记"或"flomo"的 .html 文件
```

**脚本执行失败**：
```
❌ 转换失败
错误信息：[具体错误]
```

**文件读取失败**：
```
❌ 无法读取文件：[文件名]
请检查文件是否存在且有读取权限
```

## 语言风格

- 使用简洁、直接的中文
- 用 emoji 增强可读性（✅ ❌ 📄）
- 错误信息清晰明确
- 避免冗长的技术细节

## 示例对话

**用户**：`/flomo-convert`

**助手**：
```
找到 1 个 HTML 文件：
- otonashi.z的笔记20250222.html

开始转换...

✅ 转换完成！
- 输入文件：otonashi.z的笔记20250222.html
- 输出文件：20250222-20250302.md
- 笔记条数：156 条
```

**用户**：`/flomo-convert` （多个文件时）

**助手**：
```
找到 3 个 HTML 文件：
1. otonashi.z的笔记20250222.html
2. otonashi.z的笔记20250301.html
3. flomo_export_20250315.html

请选择要转换的文件（输入序号）：
```
