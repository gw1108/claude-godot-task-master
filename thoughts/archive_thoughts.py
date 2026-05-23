import os

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shared")


def archive_thoughts(base: str = BASE) -> list[str]:
    deleted = []
    for folder in os.listdir(base):
        folder_path = os.path.join(base, folder)
        if not os.path.isdir(folder_path):
            continue
        for f in os.listdir(folder_path):
            if f.endswith(".md"):
                src = os.path.join(folder_path, f)
                os.remove(src)
                deleted.append(f"  {folder}/{f}")
    return deleted


if __name__ == "__main__":
    deleted = archive_thoughts()
    if deleted:
        print(f"Deleted {len(deleted)} file(s):")
        print("\n".join(deleted))
    else:
        print("Nothing to delete.")

    input("\nPress Enter to close...")
