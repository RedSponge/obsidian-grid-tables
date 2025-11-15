npm run build
rm -r -Force ./build
mkdir build/
mkdir build/obsidian-grid-tables
Copy-Item .\main.js build/obsidian-grid-tables
Copy-Item .\styles.css build/obsidian-grid-tables
Copy-Item .\manifest.json build/obsidian-grid-tables
Compress-Archive -Force -Path .\build\obsidian-grid-tables -DestinationPath .\build\obsidian-grid-tables.zip
