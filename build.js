// Release archiver, following the official intechstudio package
// pattern: stage the runtime files and zip them as
// package-archive.zip for the GitHub release. Tao Gunka has no
// runtime npm dependencies, so node_modules stays out.

const fs = require("fs");
const archiver = require("archiver");
const output = fs.createWriteStream("package-archive.zip");
const archive = archiver("zip", { zlib: { level: 9 } });

const subfolder = "my-project-files";
if (!fs.existsSync(subfolder)) {
  fs.mkdirSync(subfolder);
}

const excludedFiles = [
  subfolder,
  "components",
  "build.js",
  ".github",
  ".git",
  ".gitignore",
  "node_modules",
  "test",
  "tools",
  "package-lock.json",
  "package-archive.zip",
  // Generated at runtime; never ship stale copies.
  "AGENTS.md",
  "GEMINI.md",
  ".user-configs",
];

const files = fs.readdirSync(".");
for (const file of files) {
  if (!excludedFiles.includes(file)) {
    fs.renameSync(file, `${subfolder}/${file}`);
  }
}

fs.mkdirSync(`${subfolder}/components`);
fs.renameSync("components/dist", `${subfolder}/components/dist`);

output.on("close", () => {
  console.log("Archive created successfully.");
});

archive.pipe(output);
archive.directory(subfolder, false);
archive.finalize();
