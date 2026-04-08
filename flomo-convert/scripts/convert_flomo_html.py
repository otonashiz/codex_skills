#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Flomo HTML to Markdown Converter
将 flomo 导出的 HTML 笔记转换为 Markdown 格式
"""

from __future__ import annotations

import sys
from pathlib import Path

from bs4 import BeautifulSoup


def html_to_markdown(content_element):
    """将 HTML 内容转换为 Markdown 格式。"""
    markdown_lines = []

    for element in content_element.children:
        if hasattr(element, "name"):
            if element.name == "p":
                text = process_inline_elements(element)
                if text.strip():
                    markdown_lines.append(text)
            elif element.name == "ol":
                markdown_lines.extend(process_ordered_list(element))
            elif element.name == "ul":
                markdown_lines.extend(process_unordered_list(element))

    return "\n".join(markdown_lines)


def process_inline_elements(element):
    """处理行内元素。"""
    result = []

    for item in element.children:
        if isinstance(item, str):
            result.append(item)
        elif item.name == "strong":
            result.append(f"**{item.get_text()}**")
        elif item.name == "em":
            result.append(f"*{item.get_text()}*")
        elif item.name == "a":
            text = item.get_text()
            href = item.get("href", "")
            result.append(f"[{text}]({href})")
        elif item.name == "img":
            continue
        else:
            result.append(item.get_text())

    return "".join(result)


def process_ordered_list(ol_element, indent_level=0):
    """处理有序列表。"""
    lines = []
    indent = "  " * indent_level

    for i, li in enumerate(ol_element.find_all("li", recursive=False), 1):
        li_content = []
        for child in li.children:
            if child.name == "p":
                text = process_inline_elements(child)
                if text.strip():
                    li_content.append(text)
            elif child.name == "ol":
                li_content.extend(process_ordered_list(child, indent_level + 1))
            elif child.name == "ul":
                li_content.extend(process_unordered_list(child, indent_level + 1))
            elif isinstance(child, str):
                text = child.strip()
                if text:
                    li_content.append(text)

        if li_content:
            lines.append(f"{indent}{i}. {li_content[0]}")
            for line in li_content[1:]:
                if not line.startswith("  "):
                    lines.append(f"{indent}   {line}")
                else:
                    lines.append(line)

    return lines


def process_unordered_list(ul_element, indent_level=0):
    """处理无序列表。"""
    lines = []
    indent = "  " * indent_level

    for li in ul_element.find_all("li", recursive=False):
        li_content = []
        for child in li.children:
            if child.name == "p":
                text = process_inline_elements(child)
                if text.strip():
                    li_content.append(text)
            elif child.name == "ol":
                li_content.extend(process_ordered_list(child, indent_level + 1))
            elif child.name == "ul":
                li_content.extend(process_unordered_list(child, indent_level + 1))
            elif isinstance(child, str):
                text = child.strip()
                if text:
                    li_content.append(text)

        if li_content:
            lines.append(f"{indent}- {li_content[0]}")
            for line in li_content[1:]:
                if not line.startswith("  "):
                    lines.append(f"{indent}  {line}")
                else:
                    lines.append(line)

    return lines


def extract_memos_from_html(html_file_path):
    """从 HTML 文件中提取所有笔记。"""
    html_content = Path(html_file_path).read_text(encoding="utf-8")
    soup = BeautifulSoup(html_content, "html.parser")

    memos = []
    memo_divs = soup.find_all("div", class_="memo")

    for memo_div in memo_divs:
        time_div = memo_div.find("div", class_="time")
        time_str = time_div.get_text().strip() if time_div else ""

        content_div = memo_div.find("div", class_="content")
        if content_div:
            for img in content_div.find_all("img"):
                img.decompose()

            markdown_content = html_to_markdown(content_div)
            memos.append({"time": time_str, "content": markdown_content})

    return memos


def convert_to_markdown_file(html_file_path, output_md_path):
    """将 HTML 文件转换为 Markdown 文件。"""
    print(f"开始读取 HTML 文件: {html_file_path}")
    memos = extract_memos_from_html(html_file_path)
    print(f"共提取到 {len(memos)} 条笔记")

    print(f"开始写入 Markdown 文件: {output_md_path}")
    with Path(output_md_path).open("w", encoding="utf-8") as f:
        f.write("# Flomo 笔记导出\n\n")
        f.write(f"共 {len(memos)} 条笔记\n\n")
        f.write("---\n\n")

        for i, memo in enumerate(memos, 1):
            f.write(f"## 笔记 {i}\n\n")
            f.write(f"**时间:** {memo['time']}\n\n")
            f.write(f"{memo['content']}\n\n")
            f.write("---\n\n")

    print(f"转换完成！Markdown 文件已保存到: {output_md_path}")


def main():
    if len(sys.argv) != 3:
        print("用法: python3 convert_flomo_html.py 输入文件.html 输出文件.md", file=sys.stderr)
        return 1

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    if not input_path.exists():
        print(f"❌ 无法读取文件：{input_path}", file=sys.stderr)
        print("请检查文件是否存在且有读取权限", file=sys.stderr)
        return 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    convert_to_markdown_file(str(input_path), str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
