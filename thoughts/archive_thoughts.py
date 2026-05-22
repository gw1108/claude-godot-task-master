import os
import shutil

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shared")

moved = []
for folder in os.listdir(BASE):
    folder_path = os.path.join(BASE, folder)
    if not os.path.isdir(folder_path):
        continue
    archive = os.path.join(folder_path, "ARCHIVE")
    os.makedirs(archive, exist_ok=True)
    for f in os.listdir(folder_path):
        if f.endswith(".md"):
            src = os.path.join(folder_path, f)
            dst = os.path.join(archive, f)
            shutil.move(src, dst)
            moved.append(f"  {folder}/{f} -> ARCHIVE/")

if moved:
    print(f"Archived {len(moved)} file(s):")
    print("\n".join(moved))
else:
    print("Nothing to archive.")

input("\nPress Enter to close...")
