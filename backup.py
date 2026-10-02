import os
import sys
import shutil
import zipfile
from datetime import datetime

# UTF-8 encoding
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
os.makedirs(BACKUP_DIR, exist_ok=True)

timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
zip_filename = f"ff_tournament_backup_{timestamp}.zip"
zip_filepath = os.path.join(BACKUP_DIR, zip_filename)

print("========================================================")
print("[*] FREE FIRE TOURNAMENT BACKUP TOOL")
print("========================================================")
print(f"[*] Creating backup: {zip_filename}")

# Files and folders to back up
files_to_backup = [
    "app.py",
    "db_mongo.py",
    "mongo_config.json",
    "render.yaml",
    "migrate_sqlite_to_mongo.py",
    "tournament.db",
    "secret.key",
    "vapid_keys.json",
    "requirements.txt",
    "run.bat",
    "backup.bat",
    "cloudflared.exe",
    "icon.png",
    "gomon_hub_logo.png",
    "devices.json",
    "lockouts.json",
    "reset_security.json",
    ".gitignore"
]

folders_to_backup = [
    "public"
]

with zipfile.ZipFile(zip_filepath, 'w', zipfile.ZIP_DEFLATED) as zipf:
    # Add root files
    for filename in files_to_backup:
        path = os.path.join(BASE_DIR, filename)
        if os.path.exists(path):
            zipf.write(path, arcname=filename)
            print(f"  + Added: {filename}")

    # Add public folder
    for folder in folders_to_backup:
        folder_path = os.path.join(BASE_DIR, folder)
        if os.path.exists(folder_path):
            for root, dirs, files in os.walk(folder_path):
                for file in files:
                    full_p = os.path.join(root, file)
                    rel_p = os.path.relpath(full_p, BASE_DIR)
                    zipf.write(full_p, arcname=rel_p)
            print(f"  + Added folder: {folder}/")

file_size_kb = round(os.path.getsize(zip_filepath) / 1024, 2)
print("\n========================================================")
print(f"[OK] Backup created successfully!")
print(f"File: backups/{zip_filename} ({file_size_kb} KB)")
print("Keep this zip file safely on Google Drive, USB or email!")
print("========================================================\n")
