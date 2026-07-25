# -*- coding: utf-8 -*-
"""Windows native UI for Steam Quick Sell."""

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk

from update_support import (
    LATEST_RELEASE_API,
    UpdateError,
    download_file,
    download_text,
    fetch_latest_release,
    parse_sha256_file,
    select_release_update,
    sha256_file,
)

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / ".data"
APP_VERSION = "1.0.3"
BG = "#f5f7fa"
PANEL = "#ffffff"
PANEL_2 = "#f8fafc"
LINE = "#dbe3ea"
TEXT = "#17212b"
MUTED = "#667788"
BLUE = "#237fb3"
GREEN = "#278c64"
RED = "#d64c57"
PRICE_MODE_BUYER = "买家支付总价"
PRICE_MODE_RECEIVE = "卖家实收金额"
PRICE_MODE_LOWEST = "市场最低在售价"
PRICE_MODE_HIGHEST = "最高求购价（优先立即成交）"


class ApiError(RuntimeError):
    pass


class SteamQuickSellApp:
    def __init__(self, root):
        self.root = root
        self.root.title(f"Steam 库存一键出售 v{APP_VERSION}")
        self.root.geometry("940x760")
        self.root.minsize(620, 460)
        self.root.configure(bg=BG)
        icon_path = ROOT / "assets" / "efficent_sell_es_transparent.ico"
        if icon_path.exists():
            try:
                self.root.iconbitmap(default=str(icon_path))
            except tk.TclError:
                pass
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self.backend = None
        self.backend_log = None
        self.port = self.find_free_port()
        self.token = secrets.token_urlsafe(32)
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.preview = None
        self.currency = None
        self.quote_after = None
        self.job_polling = False
        self.refresh_query = None
        self.refresh_mode = "exact"
        self.refresh_cards_only = False
        self.refresh_card_price_mode = "lowest"
        self.update_info = None
        self.update_checking = False
        self.update_downloading = False
        self.sale_in_progress = False
        self.closing = False

        self.configure_styles()
        self.build_ui()
        self.set_controls_enabled(False)
        self.run_async(self.start_backend, self.backend_ready, self.backend_failed)
        self.root.after(450, self.show_previous_update_result)
        if os.environ.get("STEAM_QUICK_SELL_DISABLE_UPDATE_CHECK") != "1":
            self.root.after(1200, lambda: self.check_for_updates(silent=True))

    @staticmethod
    def find_free_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def configure_styles(self):
        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure(
            "Dark.TCombobox",
            fieldbackground=PANEL_2,
            background=PANEL_2,
            foreground=TEXT,
            arrowcolor=TEXT,
            bordercolor=LINE,
            lightcolor=LINE,
            darkcolor=LINE,
            padding=7,
        )
        style.map(
            "Dark.TCombobox",
            fieldbackground=[("readonly", PANEL_2)],
            foreground=[("readonly", TEXT)],
            selectbackground=[("readonly", PANEL_2)],
            selectforeground=[("readonly", TEXT)],
        )
        style.configure(
            "Dark.Treeview",
            background=PANEL_2,
            fieldbackground=PANEL_2,
            foreground=TEXT,
            rowheight=30,
            bordercolor=LINE,
        )
        style.configure(
            "Dark.Treeview.Heading",
            background="#eef3f7",
            foreground=TEXT,
            relief="flat",
            padding=6,
        )
        style.map(
            "Dark.Treeview",
            background=[("selected", "#dceef8")],
            foreground=[("selected", TEXT)],
        )
        style.configure(
            "Dark.Horizontal.TProgressbar",
            troughcolor=PANEL_2,
            background=GREEN,
            bordercolor=PANEL_2,
            lightcolor=GREEN,
            darkcolor=GREEN,
        )

    def build_ui(self):
        scroll_shell = tk.Frame(self.root, bg=BG)
        scroll_shell.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(
            scroll_shell,
            bg=BG,
            highlightthickness=0,
            bd=0,
        )
        scrollbar = ttk.Scrollbar(
            scroll_shell,
            orient="vertical",
            command=self.canvas.yview,
        )
        self.canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)

        scroll_content = tk.Frame(self.canvas, bg=BG)
        outer = tk.Frame(scroll_content, bg=BG)
        outer.pack(fill="both", expand=True, padx=28, pady=22)
        self.canvas_window = self.canvas.create_window(
            (0, 0),
            window=scroll_content,
            anchor="nw",
        )
        scroll_content.bind("<Configure>", self.update_scroll_region)
        self.canvas.bind("<Configure>", self.resize_scroll_content)
        self.root.bind_all("<MouseWheel>", self.on_mouse_wheel)

        header = tk.Frame(outer, bg=BG)
        self.header = header
        header.pack(fill="x", pady=(0, 18))
        title_box = tk.Frame(header, bg=BG)
        title_box.pack(side="left")
        tk.Label(
            title_box,
            text=f"LOCAL STEAM TOOL  ·  v{APP_VERSION}",
            bg=BG,
            fg=BLUE,
            font=("Segoe UI", 9, "bold"),
        ).pack(anchor="w")
        tk.Label(
            title_box,
            text="库存一键出售",
            bg=BG,
            fg=TEXT,
            font=("Microsoft YaHei UI", 26, "bold"),
        ).pack(anchor="w")

        self.status_label = tk.Label(
            header,
            text="● 正在启动后台…",
            bg=BG,
            fg="#a66b14",
            font=("Microsoft YaHei UI", 10),
        )
        self.status_label.pack(side="right", anchor="s", pady=8)
        self.update_check_button = tk.Button(
            header,
            text="检查更新",
            command=self.check_for_updates,
            bg=BG,
            fg=BLUE,
            activebackground=BG,
            activeforeground=BLUE,
            disabledforeground=MUTED,
            relief="flat",
            cursor="hand2",
            font=("Microsoft YaHei UI", 9),
        )
        self.update_check_button.pack(
            side="right",
            anchor="s",
            padx=(0, 14),
            pady=5,
        )

        self.update_panel = self.card(outer)
        update_text = tk.Frame(self.update_panel, bg=PANEL)
        update_text.pack(side="left", fill="x", expand=True, padx=22, pady=17)
        self.update_title = tk.Label(
            update_text,
            text="",
            bg=PANEL,
            fg=TEXT,
            font=("Microsoft YaHei UI", 13, "bold"),
        )
        self.update_title.pack(anchor="w")
        self.update_hint = tk.Label(
            update_text,
            text="",
            bg=PANEL,
            fg=MUTED,
            justify="left",
            wraplength=620,
            font=("Microsoft YaHei UI", 9),
        )
        self.update_hint.pack(anchor="w", pady=(5, 0))
        self.update_action_button = self.button(
            self.update_panel,
            "下载并安装",
            self.download_and_install_update,
            BLUE,
            "white",
        )
        self.update_action_button.pack(side="right", padx=22, ipadx=8)

        self.connection_panel = self.card(outer)
        login_text = tk.Frame(self.connection_panel, bg=PANEL)
        login_text.pack(side="left", fill="x", expand=True, padx=22, pady=20)
        tk.Label(
            login_text,
            text="等待 Steam 客户端",
            bg=PANEL,
            fg=TEXT,
            font=("Microsoft YaHei UI", 15, "bold"),
        ).pack(anchor="w")
        self.connection_hint = tk.Label(
            login_text,
            text="请保持桌面 Steam 正在运行并处于登录状态。",
            bg=PANEL,
            fg=MUTED,
            font=("Microsoft YaHei UI", 10),
        )
        self.connection_hint.pack(anchor="w", pady=(7, 0))
        self.reconnect_button = self.button(
            self.connection_panel, "重新检测", self.refresh_status, BLUE, "white"
        )
        self.reconnect_button.pack(side="right", padx=22, ipadx=10)

        self.workspace = tk.Frame(outer, bg=BG)

        search_card = self.card(self.workspace)
        search_card.pack(fill="x", pady=(0, 12))
        tk.Label(
            search_card,
            text="模块一  普通物品自定义价格出售",
            bg=PANEL,
            fg=TEXT,
            font=("Microsoft YaHei UI", 13, "bold"),
        ).grid(row=0, column=0, columnspan=3, sticky="w", padx=20, pady=(16, 12))
        self.name_entry = self.entry(search_card)
        self.name_entry.grid(row=1, column=0, sticky="ew", padx=(20, 10), pady=(0, 10))
        self.name_entry.insert(0, "")
        self.name_entry.bind("<Return>", lambda _event: self.scan())
        self.match_mode = tk.StringVar(value="精确匹配")
        self.mode_box = ttk.Combobox(
            search_card,
            textvariable=self.match_mode,
            values=("精确匹配", "包含关键词"),
            state="readonly",
            width=13,
            style="Dark.TCombobox",
        )
        self.mode_box.grid(row=1, column=1, padx=(0, 10), pady=(0, 10))
        self.scan_button = self.button(search_card, "扫描库存", self.scan, BLUE, "white")
        self.scan_button.grid(row=1, column=2, padx=(0, 20), pady=(0, 10), ipadx=8)
        tk.Label(
            search_card,
            text="输入完整物品名称更安全；仅匹配可在社区市场出售的物品。",
            bg=PANEL,
            fg=MUTED,
            font=("Microsoft YaHei UI", 9),
        ).grid(row=2, column=0, columnspan=3, sticky="w", padx=20, pady=(0, 15))
        search_card.grid_columnconfigure(0, weight=1)

        cards_card = self.card(self.workspace)
        cards_card.pack(fill="x", pady=(0, 12))
        tk.Label(
            cards_card,
            text="模块二  集换式卡牌市场出售",
            bg=PANEL,
            fg=TEXT,
            font=("Microsoft YaHei UI", 13, "bold"),
        ).pack(anchor="w", padx=20, pady=(16, 5))
        tk.Label(
            cards_card,
            text=(
                "自动扫描全部可出售卡牌。可按最低在售价创建挂单，"
                "也可按最高求购价优先立即成交。"
            ),
            bg=PANEL,
            fg=MUTED,
            font=("Microsoft YaHei UI", 9),
            wraplength=820,
            justify="left",
        ).pack(anchor="w", padx=20, pady=(0, 12))
        self.cards_button = self.button(
            cards_card,
            "按市场最低在售价扫描",
            lambda: self.scan_trading_cards("lowest"),
            "#dff3e9",
            "#21694f",
        )
        self.cards_button.pack(
            fill="x",
            padx=20,
            pady=(0, 8),
        )
        self.cards_buy_order_button = self.button(
            cards_card,
            "按最高求购价扫描（优先立即成交）",
            lambda: self.scan_trading_cards("highest_buy"),
            "#fff0c7",
            "#76500f",
        )
        self.cards_buy_order_button.pack(
            fill="x",
            padx=20,
            pady=(0, 16),
        )

        self.preview_card = self.card(self.workspace)
        tk.Label(
            self.preview_card,
            text="核对物品、数量与价格",
            bg=PANEL,
            fg=TEXT,
            font=("Microsoft YaHei UI", 13, "bold"),
        ).pack(anchor="w", padx=20, pady=(15, 10))

        tree_wrap = tk.Frame(self.preview_card, bg=PANEL)
        tree_wrap.pack(fill="both", expand=True, padx=20)
        self.items_tree = ttk.Treeview(
            tree_wrap,
            columns=("name", "game", "count", "market_price"),
            show="headings",
            height=5,
            style="Dark.Treeview",
        )
        self.items_tree.heading("name", text="物品")
        self.items_tree.heading("game", text="游戏")
        self.items_tree.heading("count", text="可上架数量")
        self.items_tree.heading("market_price", text="每件价格")
        self.items_tree.column("name", width=300, anchor="w")
        self.items_tree.column("game", width=210, anchor="w")
        self.items_tree.column("count", width=80, anchor="center")
        self.items_tree.column("market_price", width=150, anchor="e")
        scrollbar = ttk.Scrollbar(tree_wrap, orient="vertical", command=self.items_tree.yview)
        self.items_tree.configure(yscrollcommand=scrollbar.set)
        self.items_tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        self.preview_summary = tk.Label(
            self.preview_card,
            text="",
            bg=PANEL,
            fg=MUTED,
            font=("Microsoft YaHei UI", 9),
        )
        self.preview_summary.pack(anchor="w", padx=20, pady=(8, 10))

        pricing = tk.Frame(self.preview_card, bg=PANEL)
        pricing.pack(fill="x", padx=20)
        pricing.grid_columnconfigure(1, weight=1)
        pricing.grid_columnconfigure(2, weight=1)

        self.quantity_var = tk.IntVar(value=1)
        self.price_var = tk.StringVar()
        self.price_mode = tk.StringVar(value=PRICE_MODE_BUYER)

        self.quantity_label = self.field_label(pricing, "出售数量（可上架 0 件）")
        self.quantity_label.grid(row=0, column=0, sticky="w")
        self.price_label = self.field_label(pricing, "每件价格（Steam 钱包币种）")
        self.price_label.grid(row=0, column=1, sticky="w", padx=(12, 0))
        self.field_label(pricing, "价格含义").grid(row=0, column=2, sticky="w", padx=(12, 0))

        self.quantity_spin = tk.Spinbox(
            pricing,
            from_=1,
            to=1,
            textvariable=self.quantity_var,
            bg=PANEL_2,
            fg=TEXT,
            insertbackground=TEXT,
            buttonbackground="#dce5eb",
            relief="flat",
            width=10,
            font=("Segoe UI", 11),
        )
        self.quantity_spin.grid(row=1, column=0, sticky="ew", ipady=8)
        self.price_entry = self.entry(pricing, self.price_var)
        self.price_entry.grid(row=1, column=1, sticky="ew", padx=(12, 0))
        self.price_entry.bind("<KeyRelease>", self.schedule_quote)
        self.price_mode_box = ttk.Combobox(
            pricing,
            textvariable=self.price_mode,
            values=(PRICE_MODE_BUYER, PRICE_MODE_RECEIVE),
            state="readonly",
            style="Dark.TCombobox",
        )
        self.price_mode_box.grid(row=1, column=2, sticky="ew", padx=(12, 0))
        self.price_mode_box.bind("<<ComboboxSelected>>", self.on_price_mode_changed)

        self.quote_label = tk.Label(
            self.preview_card,
            text="输入价格后显示手续费预估",
            bg=PANEL_2,
            fg=MUTED,
            anchor="w",
            padx=12,
            pady=10,
            font=("Microsoft YaHei UI", 9),
        )
        self.quote_label.pack(fill="x", padx=20, pady=(12, 8))

        self.confirm_var = tk.BooleanVar(value=False)
        self.confirm_check = tk.Checkbutton(
            self.preview_card,
            text="我已核对物品、数量和每件价格，确认提交 Steam 市场出售请求",
            variable=self.confirm_var,
            command=self.update_sell_state,
            bg=PANEL,
            fg=TEXT,
            activebackground=PANEL,
            activeforeground=TEXT,
            selectcolor=PANEL_2,
            font=("Microsoft YaHei UI", 9),
        )
        self.confirm_check.pack(anchor="w", padx=20)
        self.sell_button = self.button(
            self.preview_card, "一键出售", self.sell, RED, "white"
        )
        self.sell_button.pack(fill="x", padx=20, pady=(10, 18))

        self.progress_card = self.card(self.workspace)
        tk.Label(
            self.progress_card,
            text="出售进度",
            bg=PANEL,
            fg=TEXT,
            font=("Microsoft YaHei UI", 13, "bold"),
        ).pack(anchor="w", padx=20, pady=(15, 8))
        self.progress_text = tk.Label(
            self.progress_card,
            text="准备中…",
            bg=PANEL,
            fg=TEXT,
            font=("Microsoft YaHei UI", 10, "bold"),
        )
        self.progress_text.pack(anchor="w", padx=20)
        self.progress_bar = ttk.Progressbar(
            self.progress_card,
            orient="horizontal",
            mode="determinate",
            style="Dark.Horizontal.TProgressbar",
        )
        self.progress_bar.pack(fill="x", padx=20, pady=8)
        self.result_summary = tk.Label(
            self.progress_card,
            text="",
            bg=PANEL,
            fg=MUTED,
            anchor="w",
            font=("Microsoft YaHei UI", 9),
        )
        self.result_summary.pack(fill="x", padx=20)
        self.result_list = tk.Listbox(
            self.progress_card,
            height=5,
            bg=PANEL_2,
            fg=TEXT,
            selectbackground="#dceef8",
            selectforeground=TEXT,
            relief="flat",
            highlightthickness=0,
            font=("Microsoft YaHei UI", 9),
        )
        self.result_list.pack(fill="both", expand=True, padx=20, pady=(8, 16))

    @staticmethod
    def card(parent):
        return tk.Frame(
            parent,
            bg=PANEL,
            highlightbackground=LINE,
            highlightthickness=1,
            bd=0,
        )

    def update_scroll_region(self, _event=None):
        bounds = self.canvas.bbox("all")
        if bounds:
            self.canvas.configure(scrollregion=(0, 0, bounds[2], bounds[3] + 12))

    def resize_scroll_content(self, event):
        self.canvas.itemconfigure(self.canvas_window, width=event.width)
        self.update_scroll_region()

    def on_mouse_wheel(self, event):
        bounds = self.canvas.bbox("all")
        if not bounds or bounds[3] <= self.canvas.winfo_height():
            return
        steps = -1 if event.delta > 0 else 1
        self.canvas.yview_scroll(steps * 3, "units")
        return "break"

    @staticmethod
    def button(parent, text, command, background, foreground):
        return tk.Button(
            parent,
            text=text,
            command=command,
            bg=background,
            fg=foreground,
            activebackground=background,
            activeforeground=foreground,
            disabledforeground="#9aa8b3",
            relief="flat",
            cursor="hand2",
            padx=16,
            pady=9,
            font=("Microsoft YaHei UI", 10, "bold"),
        )

    @staticmethod
    def entry(parent, variable=None):
        return tk.Entry(
            parent,
            textvariable=variable,
            bg=PANEL_2,
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            highlightbackground=LINE,
            highlightcolor=BLUE,
            highlightthickness=1,
            font=("Microsoft YaHei UI", 11),
        )

    @staticmethod
    def field_label(parent, text):
        return tk.Label(
            parent,
            text=text,
            bg=PANEL,
            fg=MUTED,
            font=("Microsoft YaHei UI", 9),
        )

    def check_for_updates(self, silent=False):
        if self.update_checking or self.update_downloading:
            return
        self.update_checking = True
        self.update_check_button.configure(text="检查中…", state="disabled")
        api_url = os.environ.get(
            "STEAM_QUICK_SELL_UPDATE_API_URL",
            LATEST_RELEASE_API,
        )

        def checked(update):
            self.update_checking = False
            self.update_check_button.configure(state="normal")
            self.update_info = update
            if update.get("is_newer"):
                self.show_update_available(update)
                self.update_check_button.configure(text="发现新版本")
            else:
                self.update_panel.pack_forget()
                self.update_check_button.configure(text="已是最新版")
                self.root.after(2600, self.restore_update_check_text)

        def failed(error):
            self.update_checking = False
            self.update_check_button.configure(text="检查更新", state="normal")
            if not silent:
                messagebox.showwarning("检查更新失败", str(error))

        self.run_async(
            lambda: select_release_update(
                fetch_latest_release(api_url=api_url),
                APP_VERSION,
            ),
            checked,
            failed,
        )

    def restore_update_check_text(self):
        if (
            not self.update_checking
            and not self.update_downloading
            and not (self.update_info or {}).get("is_newer")
        ):
            self.update_check_button.configure(text="检查更新")

    def show_update_available(self, update):
        version = update.get("version", "")
        notes = " ".join(str(update.get("notes") or "").split())
        if len(notes) > 210:
            notes = notes[:207].rstrip() + "…"
        installable = bool(
            update.get("zip_url")
            and (update.get("sha256") or update.get("checksum_url"))
        )
        self.update_title.configure(text=f"发现新版本 v{version}")
        if installable:
            detail = notes or "新版已经可以下载，安装前会自动校验文件完整性。"
            self.update_hint.configure(
                text=f"{detail}\n更新期间程序会自动关闭，完成后重新启动。",
            )
            self.update_action_button.configure(
                text="下载并安装",
                command=self.download_and_install_update,
                state="normal",
                bg=BLUE,
                fg="white",
            )
        else:
            self.update_hint.configure(
                text=(
                    (notes + "\n" if notes else "")
                    + "此 Release 没有可校验的自动更新包，请从发布页面手动下载。"
                ),
            )
            self.update_action_button.configure(
                text="查看发布页面",
                command=self.open_release_page,
                state="normal",
                bg=PANEL_2,
                fg=BLUE,
            )
        self.update_panel.pack(
            fill="x",
            pady=(0, 12),
            after=self.header,
        )
        self.root.update_idletasks()
        self.update_scroll_region()

    def open_release_page(self):
        url = str((self.update_info or {}).get("html_url") or "").strip()
        if not url.startswith(
            "https://github.com/kristong769-maker/efficient_sell/releases/"
        ):
            url = "https://github.com/kristong769-maker/efficient_sell/releases"
        webbrowser.open(url)

    def download_and_install_update(self):
        update = self.update_info or {}
        if self.update_downloading:
            return
        if self.sale_in_progress:
            messagebox.showwarning(
                "暂时不能更新",
                "请等待当前上架任务和库存刷新完成后再更新。",
            )
            return
        if not (
            update.get("zip_url")
            and (update.get("sha256") or update.get("checksum_url"))
        ):
            self.open_release_page()
            return
        version = str(update.get("version") or "")
        if not messagebox.askyesno(
            "安装程序更新",
            f"确认下载并安装 v{version} 吗？\n\n"
            "下载完成后程序会自动关闭、替换文件并重新启动。"
            "\nSteam 登录状态和本地日志不会被删除。",
        ):
            return

        self.update_downloading = True
        self.set_controls_enabled(False)
        self.update_check_button.configure(text="正在下载…", state="disabled")
        self.update_action_button.configure(text="正在下载更新包…", state="disabled")

        def downloaded(result):
            self.update_action_button.configure(text="正在启动更新器…")
            try:
                self.launch_updater(result)
            except Exception as error:
                download_failed(error)

        def download_failed(error):
            self.update_downloading = False
            self.update_check_button.configure(text="发现新版本", state="normal")
            self.update_action_button.configure(
                text="重试下载",
                state="normal",
                command=self.download_and_install_update,
            )
            if self.workspace.winfo_ismapped():
                self.set_controls_enabled(True)
                self.update_sell_state()
            messagebox.showerror("更新下载失败", str(error))

        self.run_async(
            lambda: self.download_update_package(update),
            downloaded,
            download_failed,
        )

    @staticmethod
    def download_update_package(update):
        zip_name = Path(str(update.get("zip_name") or "")).name
        if not zip_name or zip_name != str(update.get("zip_name") or ""):
            raise UpdateError("更新包文件名无效")
        expected = str(update.get("sha256") or "").lower()
        if not expected:
            checksum_text = download_text(update.get("checksum_url"))
            expected = parse_sha256_file(checksum_text, zip_name)
        update_dir = DATA_DIR / "updates"
        package_path = update_dir / zip_name
        download_file(update.get("zip_url"), package_path)
        actual = sha256_file(package_path)
        if actual != expected:
            package_path.unlink(missing_ok=True)
            raise UpdateError("更新包完整性校验失败，文件已删除")
        return {
            "package": package_path,
            "sha256": actual,
            "version": str(update.get("version") or ""),
        }

    def launch_updater(self, result):
        updater_path = ROOT / "updater.py"
        if not updater_path.exists():
            raise UpdateError("程序目录缺少 updater.py")
        python_executable = Path(sys.executable)
        if python_executable.name.lower() == "python.exe":
            pythonw = python_executable.with_name("pythonw.exe")
            if pythonw.exists():
                python_executable = pythonw
        command = [
            str(python_executable),
            str(updater_path),
            "--package",
            str(result["package"]),
            "--sha256",
            result["sha256"],
            "--version",
            result["version"],
            "--app-dir",
            str(ROOT),
            "--wait-pid",
            str(os.getpid()),
        ]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen(
            command,
            cwd=str(ROOT),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )
        self.root.after(150, self.close)

    def show_previous_update_result(self):
        result_path = DATA_DIR / "update-result.json"
        if not result_path.exists():
            return
        try:
            result = json.loads(result_path.read_text(encoding="utf-8-sig"))
            result_path.unlink()
        except (OSError, json.JSONDecodeError):
            return
        if result.get("success"):
            messagebox.showinfo(
                "更新完成",
                f"程序已成功更新到 v{result.get('version', APP_VERSION)}。",
            )
        else:
            messagebox.showerror(
                "更新失败",
                str(result.get("message") or "更新器没有完成文件替换，已尝试恢复旧版本。"),
            )

    def start_backend(self):
        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise ApiError("未找到 Node.js，请先安装 Node.js 20 或更高版本")
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.backend_log = open(DATA_DIR / "backend.log", "ab", buffering=0)
        env = os.environ.copy()
        env.update(
            {
                "STEAM_QUICK_SELL_NATIVE": "1",
                "STEAM_QUICK_SELL_STEAM_CLIENT": "1",
                "STEAM_QUICK_SELL_PORT": str(self.port),
                "STEAM_QUICK_SELL_APP_TOKEN": self.token,
            }
        )
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.backend = subprocess.Popen(
            [node, str(ROOT / "src" / "main.js")],
            cwd=str(ROOT),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=self.backend_log,
            stderr=self.backend_log,
            creationflags=flags,
        )
        deadline = time.time() + 25
        while time.time() < deadline:
            if self.backend.poll() is not None:
                raise ApiError("后台启动失败，请查看 .data/backend.log")
            try:
                self.api("/api/bootstrap")
                return
            except Exception:
                time.sleep(0.35)
        raise ApiError("后台启动超时，请查看 .data/backend.log")

    def api(self, path, method="GET", payload=None, timeout=70):
        data = None
        headers = {"Content-Type": "application/json"}
        if method != "GET":
            data = json.dumps(payload or {}).encode("utf-8")
            headers["Origin"] = self.base_url
            headers["X-App-Token"] = self.token
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
                message = body.get("error") or str(error)
            except Exception:
                message = str(error)
            raise ApiError(message) from error
        except urllib.error.URLError as error:
            raise ApiError(f"无法连接本地后台：{error.reason}") from error

    def run_async(self, work, success=None, failure=None):
        def target():
            try:
                result = work()
                if success:
                    self.safe_after(lambda: success(result))
            except Exception as error:
                callback = failure or self.show_error
                self.safe_after(lambda: callback(error))

        threading.Thread(target=target, daemon=True).start()

    def safe_after(self, callback):
        try:
            self.root.after(0, callback)
        except tk.TclError:
            pass

    def backend_ready(self, _result):
        self.refresh_status()

    def backend_failed(self, error):
        self.status_label.configure(text="● 启动失败", fg=RED)
        messagebox.showerror("启动失败", str(error))

    def refresh_status(self):
        self.status_label.configure(text="● 正在检查登录状态…", fg="#a66b14")
        self.run_async(
            lambda: self.api("/api/status"),
            self.apply_status,
            self.show_error,
        )

    def apply_status(self, status):
        logged_in = bool(status.get("loggedIn"))
        if logged_in:
            self.status_label.configure(
                text=f"● 已登录 · {status.get('steamId', '')}", fg=GREEN
            )
            self.connection_panel.pack_forget()
            self.workspace.pack(fill="both", expand=True)
            self.currency = status.get("currency")
            currency_code = (self.currency or {}).get("code", "")
            self.price_label.configure(
                text=f"每件价格（{currency_code}）"
                if currency_code
                else "每件价格（Steam 钱包币种）"
            )
            self.set_controls_enabled(True)
            if status.get("warning"):
                messagebox.showwarning("Steam 市场提示", status["warning"])
        else:
            self.status_label.configure(text="● 未连接 Steam 客户端", fg=RED)
            self.workspace.pack_forget()
            self.connection_hint.configure(
                text=status.get("warning")
                or "请保持桌面 Steam 正在运行并处于登录状态。"
            )
            self.connection_panel.pack(fill="x")
            self.reconnect_button.configure(state="normal", text="重新检测")

    def set_controls_enabled(self, enabled):
        state = "normal" if enabled else "disabled"
        for control in (
            self.name_entry,
            self.scan_button,
            self.cards_button,
            self.cards_buy_order_button,
        ):
            control.configure(state=state)
        if not enabled:
            self.sell_button.configure(state="disabled")

    def scan(self):
        name = self.name_entry.get().strip()
        if not name:
            messagebox.showinfo("请输入名称", "请先输入要出售的物品名称")
            self.name_entry.focus_set()
            return
        self.scan_button.configure(state="disabled", text="正在扫描…")
        self.cards_button.configure(state="disabled")
        self.cards_buy_order_button.configure(state="disabled")
        mode = "contains" if self.match_mode.get() == "包含关键词" else "exact"
        self.run_async(
            lambda: self.api(
                "/api/preview",
                "POST",
                {"name": name, "mode": mode},
                timeout=180,
            ),
            self.render_preview,
            self.scan_failed,
        )

    def scan_trading_cards(self, card_price_mode):
        self.scan_button.configure(state="disabled")
        self.cards_button.configure(state="disabled")
        self.cards_buy_order_button.configure(state="disabled")
        active_button = (
            self.cards_buy_order_button
            if card_price_mode == "highest_buy"
            else self.cards_button
        )
        active_button.configure(
            text=(
                "正在读取卡牌与最高求购价…"
                if card_price_mode == "highest_buy"
                else "正在读取卡牌与最低在售价…"
            )
        )
        self.run_async(
            lambda: self.api(
                "/api/preview",
                "POST",
                {
                    "tradingCardsOnly": True,
                    "cardPriceMode": card_price_mode,
                },
                timeout=240,
            ),
            self.render_preview,
            self.scan_failed,
        )

    def scan_failed(self, error):
        self.scan_button.configure(state="normal", text="扫描库存")
        self.cards_button.configure(
            state="normal",
            text="按市场最低在售价扫描",
        )
        self.cards_buy_order_button.configure(
            state="normal",
            text="按最高求购价扫描（优先立即成交）",
        )
        self.show_error(error)

    def render_preview(self, preview, show_warnings=True):
        self.scan_button.configure(state="normal", text="扫描库存")
        self.cards_button.configure(
            state="normal",
            text="按市场最低在售价扫描",
        )
        self.cards_buy_order_button.configure(
            state="normal",
            text="按最高求购价扫描（优先立即成交）",
        )
        self.preview = preview
        card_price_mode = preview.get("cardPriceMode")
        self.items_tree.heading(
            "market_price",
            text=(
                "最高求购价"
                if card_price_mode == "highest_buy"
                else "市场最低在售价"
                if card_price_mode == "lowest"
                else "每件价格"
            ),
        )
        self.items_tree.delete(*self.items_tree.get_children())
        for group in preview.get("groups", []):
            self.items_tree.insert(
                "",
                "end",
                values=(
                    group.get("name", ""),
                    group.get("appName", ""),
                    group.get("count", 0),
                    group.get("marketPriceFormatted") or "—",
                ),
            )
        count = int(preview.get("usableCount", 0))
        self.quantity_label.configure(
            text=(
                f"出售数量（最高价求购可接收 {count} 件）"
                if card_price_mode == "highest_buy"
                else f"出售数量（可上架 {count} 件）"
            )
        )
        self.quantity_spin.configure(to=max(1, count))
        self.quantity_var.set(count)
        self.preview_summary.configure(
            text=(
                (
                    f"可按最高求购价出售 {count} 件 · "
                    if card_price_mode == "highest_buy"
                    else f"可上架 {count} 件 · "
                )
                +
                f"扫描 {preview.get('scannedContexts', 0)} 个库存 · "
                f"检查 {preview.get('scannedAssets', 0)} 件物品"
            )
        )
        self.confirm_var.set(False)
        if card_price_mode == "highest_buy":
            self.price_mode_box.configure(values=(PRICE_MODE_HIGHEST,))
            self.price_mode.set(PRICE_MODE_HIGHEST)
        elif card_price_mode == "lowest":
            self.price_mode_box.configure(values=(PRICE_MODE_LOWEST,))
            self.price_mode.set(PRICE_MODE_LOWEST)
        else:
            self.price_mode_box.configure(
                values=(PRICE_MODE_BUYER, PRICE_MODE_RECEIVE)
            )
            if self.price_mode.get() not in (PRICE_MODE_BUYER, PRICE_MODE_RECEIVE):
                self.price_mode.set(PRICE_MODE_BUYER)
        self.on_price_mode_changed()
        self.update_sell_state()
        if not self.preview_card.winfo_ismapped():
            self.preview_card.pack(fill="both", expand=True, pady=(0, 12))
        warnings = []
        if preview.get("truncated"):
            warnings.append(f"本次最多处理 {count} 件")
        if preview.get("demandLimited"):
            warnings.append(
                "部分卡牌持有数量超过当前最高价求购数量，"
                "已只保留预计可立即成交的数量"
            )
        if preview.get("errors"):
            warnings.append("部分库存读取失败：" + "；".join(preview["errors"]))
        if preview.get("priceErrors"):
            warnings.append(
                (
                    "部分卡牌没有取得有效求购价："
                    if card_price_mode == "highest_buy"
                    else "部分卡牌没有取得最低在售价："
                )
                + "；".join(preview["priceErrors"])
            )
        if int(preview.get("totalFound", 0)) == 0:
            warnings.append(
                "没有找到可出售的集换式卡牌"
                if preview.get("tradingCardsOnly")
                else "没有找到名称匹配且可出售的物品"
            )
        if warnings and show_warnings:
            messagebox.showwarning("扫描结果", "\n".join(warnings))

    def schedule_quote(self, _event=None):
        if self.price_mode.get() in (PRICE_MODE_LOWEST, PRICE_MODE_HIGHEST):
            self.update_quote()
            self.update_sell_state()
            return
        if self.quote_after:
            self.root.after_cancel(self.quote_after)
        self.quote_after = self.root.after(350, self.update_quote)
        self.update_sell_state()

    def update_quote(self):
        selected_mode = self.price_mode.get()
        if selected_mode in (PRICE_MODE_LOWEST, PRICE_MODE_HIGHEST):
            if self.preview and self.preview.get("marketBuyerPriceFormatted"):
                mode_text = (
                    "按当前最高求购价优先立即成交"
                    if selected_mode == PRICE_MODE_HIGHEST
                    else "按当前市场最低在售价创建挂单"
                )
                self.quote_label.configure(
                    text=(
                        f"{mode_text} · "
                        f"买家价格 {self.preview.get('marketBuyerPriceFormatted')} · "
                        f"预计实收 {self.preview.get('marketSellerPriceFormatted')}"
                    ),
                    fg=TEXT,
                )
            else:
                self.quote_label.configure(
                    text=(
                        "请先扫描集换式卡牌并获取最高求购价"
                        if selected_mode == PRICE_MODE_HIGHEST
                        else "请先扫描集换式卡牌并获取市场最低在售价"
                    ),
                    fg=MUTED,
                )
            return
        price = self.price_var.get().strip()
        if not price or not self.preview:
            self.quote_label.configure(text="输入价格后显示手续费预估", fg=MUTED)
            return
        payload = {
            "price": price,
            "priceMode": "receive"
            if self.price_mode.get() == PRICE_MODE_RECEIVE
            else "buyer",
            "previewId": self.preview.get("previewId"),
        }

        def shown(result):
            self.quote_label.configure(
                text=(
                    f"每件：买家支付 {result.get('buyerPays')} · "
                    f"预计实收 {result.get('sellerReceives')} · "
                    f"手续费 {result.get('fees')}"
                ),
                fg=TEXT,
            )

        self.run_async(
            lambda: self.api("/api/quote", "POST", payload),
            shown,
            lambda error: self.quote_label.configure(text=str(error), fg=RED),
        )

    def on_price_mode_changed(self, _event=None):
        automatic_mode = self.price_mode.get() in (
            PRICE_MODE_LOWEST,
            PRICE_MODE_HIGHEST,
        )
        self.price_entry.configure(state="disabled" if automatic_mode else "normal")
        if automatic_mode:
            self.price_var.set("")
        self.schedule_quote()

    def update_sell_state(self):
        automatic_mode = self.price_mode.get() in (
            PRICE_MODE_LOWEST,
            PRICE_MODE_HIGHEST,
        )
        price_ready = (
            bool(self.preview and self.preview.get("marketBuyerPriceFormatted"))
            if automatic_mode
            else bool(self.price_var.get().strip())
        )
        valid = (
            self.preview is not None
            and int(self.preview.get("usableCount", 0)) > 0
            and self.confirm_var.get()
            and price_ready
        )
        self.sell_button.configure(state="normal" if valid else "disabled")

    def sell(self):
        if not self.preview:
            return
        selected_mode = self.price_mode.get()
        lowest_mode = selected_mode == PRICE_MODE_LOWEST
        highest_buy_mode = selected_mode == PRICE_MODE_HIGHEST
        try:
            quantity = int(self.quantity_var.get())
        except (TypeError, ValueError):
            messagebox.showerror("数量错误", "请输入有效的出售数量")
            return
        available = int(self.preview.get("usableCount", 0))
        if quantity < 1 or quantity > available:
            messagebox.showerror(
                "数量错误",
                f"出售数量必须在 1 到 {available} 之间",
            )
            return
        price_description = (
            "扫描时取得的最高求购价"
            if highest_buy_mode
            else "扫描时取得的市场最低在售价"
            if lowest_mode
            else "当前输入的价格"
        )
        action_hint = (
            "提交后会优先与最高求购单立即成交；若市场在提交前发生变化，"
            "Steam 可能会创建同价挂单。"
            if highest_buy_mode
            else "提交后会创建真实的 Steam 社区市场挂单。"
        )
        if not messagebox.askyesno(
            "最终确认",
            f"确认以{price_description}出售 {quantity} 件匹配物品吗？\n\n"
            f"{action_hint}",
            icon="warning",
        ):
            return
        payload = {
            "previewId": self.preview.get("previewId"),
            "confirmToken": self.preview.get("confirmToken"),
            "quantity": quantity,
            "price": self.price_var.get().strip(),
            "priceMode": (
                "market_highest_buy"
                if highest_buy_mode
                else "market_lowest"
                if lowest_mode
                else "receive"
                if selected_mode == PRICE_MODE_RECEIVE
                else "buyer"
            ),
        }
        self.refresh_query = self.preview.get("query") or self.name_entry.get().strip()
        self.refresh_mode = self.preview.get("mode") or "exact"
        self.refresh_cards_only = bool(self.preview.get("tradingCardsOnly"))
        self.refresh_card_price_mode = (
            self.preview.get("cardPriceMode") or "lowest"
        )
        self.sale_in_progress = True
        self.sell_button.configure(state="disabled", text="正在创建任务…")
        self.run_async(
            lambda: self.api("/api/sell", "POST", payload),
            self.sell_started,
            self.sell_failed,
        )

    def sell_failed(self, error):
        self.sale_in_progress = False
        self.sell_button.configure(text="一键出售")
        self.update_sell_state()
        self.show_error(error)

    def sell_started(self, job):
        self.preview = None
        self.progress_card.pack(fill="both", expand=True, pady=(0, 12))
        self.job_polling = True
        self.sell_button.configure(text="一键出售", state="disabled")
        self.render_job(job)
        self.root.after_idle(lambda: self.canvas.yview_moveto(1.0))
        self.root.after(800, lambda: self.poll_job(job.get("id")))

    def poll_job(self, job_id):
        if not self.job_polling:
            return

        def received(job):
            self.render_job(job)
            if job.get("state") == "finished":
                self.job_polling = False
                message = (
                    "任务完成。"
                    if not int(job.get("failed", 0))
                    else "任务完成，部分物品上架失败。"
                )
                if int(job.get("needsConfirmation", 0)):
                    message += "\n请在 Steam 手机令牌或邮箱中完成确认。"
                if job.get("immediateMatchMode"):
                    message += (
                        "\n已按扫描时的最高求购价提交；"
                        "最终成交状态请以 Steam 市场记录为准。"
                    )
                self.refresh_inventory_after_job(message)
            else:
                self.root.after(900, lambda: self.poll_job(job_id))

        self.run_async(
            lambda: self.api(f"/api/jobs/{job_id}"),
            received,
            lambda _error: self.root.after(1500, lambda: self.poll_job(job_id)),
        )

    def refresh_inventory_after_job(self, result_message):
        if not self.refresh_query and not self.refresh_cards_only:
            self.sale_in_progress = False
            messagebox.showinfo("上架结果", result_message)
            return
        self.progress_text.configure(text="任务完成，正在更新库存…")
        self.scan_button.configure(state="disabled", text="正在更新库存…")
        self.cards_button.configure(state="disabled")
        self.cards_buy_order_button.configure(state="disabled")
        payload = (
            {
                "tradingCardsOnly": True,
                "cardPriceMode": self.refresh_card_price_mode,
            }
            if self.refresh_cards_only
            else {
                "name": self.refresh_query,
                "mode": self.refresh_mode,
            }
        )

        def refreshed(preview):
            self.sale_in_progress = False
            self.force_refresh_listing_page(preview)
            messagebox.showinfo(
                "上架结果",
                result_message + "\n\n库存和一键上架页面已强制刷新。",
            )

        def refresh_failed(error):
            self.sale_in_progress = False
            self.scan_button.configure(state="normal", text="扫描库存")
            self.cards_button.configure(
                state="normal",
                text="按市场最低在售价扫描",
            )
            self.cards_buy_order_button.configure(
                state="normal",
                text="按最高求购价扫描（优先立即成交）",
            )
            self.progress_text.configure(text="任务完成，库存更新失败")
            messagebox.showwarning(
                "上架结果",
                result_message + f"\n\n库存自动更新失败：{error}",
            )

        self.run_async(
            lambda: self.api(
                "/api/preview",
                "POST",
                payload,
                timeout=180,
            ),
            refreshed,
            refresh_failed,
        )

    def force_refresh_listing_page(self, preview):
        self.price_var.set("")
        self.confirm_var.set(False)
        self.quote_label.configure(
            text="输入价格后显示手续费预估",
            fg=MUTED,
        )
        self.progress_card.pack_forget()
        self.progress_bar.configure(value=0)
        self.progress_text.configure(text="准备中…")
        self.result_summary.configure(text="")
        self.result_list.delete(0, "end")
        self.render_preview(preview, show_warnings=False)
        self.update_sell_state()
        self.root.update_idletasks()
        self.update_scroll_region()
        self.canvas.yview_moveto(0.0)

    def render_job(self, job):
        total = max(1, int(job.get("total", 0)))
        completed = int(job.get("completed", 0))
        self.progress_bar.configure(maximum=total, value=completed)
        self.progress_text.configure(
            text=(
                "任务完成"
                if job.get("state") == "finished"
                else (
                    f"检测到 Steam 限流，已切换单线程稳定模式…  "
                    f"{completed} / {total}"
                )
                if job.get("stabilityMode")
                else (
                    f"正在 {job.get('concurrency', 1)} 路并发上架…  "
                    f"{completed} / {total}"
                )
            )
        )
        self.result_summary.configure(
            text=(
                f"成功 {job.get('succeeded', 0)} 件 · "
                f"失败 {job.get('failed', 0)} 件 · "
                f"临时重试 {job.get('transientRetries', 0)} 次 · "
                f"每件买家支付 {job.get('buyerPaysFormatted', '')} · "
                f"预计实收 {job.get('sellerReceivesFormatted', '')}"
            )
        )
        self.result_list.delete(0, "end")
        for result in reversed(job.get("results", [])):
            amount = int(result.get("amount", 1))
            name = result.get("name", "")
            if amount > 1:
                name += f" × {amount}"
            mark = "✓" if result.get("ok") else "✕"
            self.result_list.insert("end", f"{mark}  {name} — {result.get('message', '')}")

    def show_error(self, error):
        messagebox.showerror("操作失败", str(error))

    def close(self):
        if self.closing:
            return
        self.closing = True
        self.job_polling = False
        try:
            if self.backend and self.backend.poll() is None:
                try:
                    self.api("/api/shutdown", "POST", {}, timeout=3)
                    self.backend.wait(timeout=4)
                except Exception:
                    self.backend.terminate()
        finally:
            if self.backend_log:
                self.backend_log.close()
            self.root.destroy()


def main():
    root = tk.Tk()
    app = SteamQuickSellApp(root)
    auto_close_ms = int(os.environ.get("STEAM_QUICK_SELL_UI_AUTOCLOSE_MS", "0"))
    if auto_close_ms > 0:
        root.after(auto_close_ms, app.close)
    root.mainloop()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            messagebox.showerror("Steam 一键出售", str(exc))
        except Exception:
            pass
        raise
