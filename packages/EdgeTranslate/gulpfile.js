const _ = require("lodash");
const path = require("path");
const del = require("del");
const gulp = require("gulp");
const stylus = require("gulp-stylus");
const fs = require("fs");
const through = require("through2");
const webpack = require("webpack");
const webpack_stream = require("webpack-stream");
const zip = require("gulp-zip");
const terser = require("gulp-terser");
const eslint = require("gulp-eslint");
const mergeStream = require("merge-stream");
const minimist = require("minimist");
const spawn = require("child_process").spawn;

let args = minimist(process.argv.slice(2));
let browser = args.browser || "chrome"; // store the name of browser: enum{chrome,firefox}
let environment; // store the type of environment: enum{production,development}

/**
 * Define public tasks of gulp
 */

/**
 *
 * A public task to build JS in development mode
 *
 * Hint: The watch mode of webpack in development mode will block the current gulp task. So this task need to to be run independently in command line in another process
 */
exports.buildJS = gulp.series(setDevelopEnvironment, buildJS);

/**
 * A public task to build a package in development mode and watch code changes.
 */
exports.dev = gulp.series(
    setDevelopEnvironment,
    clean,
    gulp.parallel(eslintJS, buildJSDev, manifest, html, styl, packStatic),
    watcher
);

/**
 * A public task to build a package in production mode
 */
exports.build = gulp.series(
    setProductEnvironment,
    clean,
    gulp.parallel(eslintJS, buildJS, manifest, html, styl, packStatic)
);

/**
 * A public task to build and zip a package in production mode
 */
exports.pack = gulp.series(
    setProductEnvironment,
    clean,
    gulp.parallel(eslintJS, buildJS, manifest, html, styl, packStatic),
    function maybeZip(done) {
        // Safari는 zip 불필요 (Xcode 연동으로 대체)
        if (browser === "safari") return done();
        return packToZip();
    }
);
/**
 * End public tasks' definition
 */

/**
 * Define private tasks of gulp
 */

/**
 * A private task to set development execution environment
 */
function setDevelopEnvironment(done) {
    environment = "development";
    done();
}

/**
 * A private task to set production execution environment
 */
function setProductEnvironment(done) {
    environment = "production";
    done();
}

/**
 * A private task to clean old packages before building new ones
 */
function clean() {
    let output_dir = `./build/${browser}/`;
    let packageName = `edge_translate_${browser}.zip`;
    return del([output_dir, `./build/${packageName}`]);
}

/**
 * 将build的扩展打包成zip文件以备发布
 */
function packToZip() {
    let match_dir = `./build/${browser}/**/*`;
    let packageName = `edge_translate_${browser}.zip`;
    return gulp.src(match_dir).pipe(zip(packageName)).pipe(gulp.dest("./build/"));
}

/**
 * A private task to watch change of code and update the package immediately
 * @param {Function} done execute done to inform gulp that the task is finished
 */
function watcher(done) {
    gulp.watch("./src/**/*.{js,jsx}").on("change", gulp.series(eslintJS));
    gulp.watch("./src/(manifest|manifest_chrome|manifest_firefox|manifest_safari).json").on(
        "change",
        gulp.series(manifest)
    );
    gulp.watch("./src/**/*.html").on("change", gulp.series(html));
    gulp.watch("./static/**/*").on("change", gulp.series(packStatic));
    gulp.watch("./src/**/*.styl").on("change", gulp.series(styl));
    done();
}

/**
 * A private task to run eslint check for JS code
 */
function eslintJS() {
    return gulp
        .src("./src/**/*.{js,jsx}", { base: "src" })
        .pipe(
            eslint({
                configFile: "./.eslintrc.js",
            })
        )
        .pipe(eslint.format());
}

/**
 * A private code to build JS code
 */
function buildJS() {
    let output_dir = `./build/${browser}/`;
    let webpack_path =
        environment === "production"
            ? "./config/webpack.prod.config.js"
            : "./config/webpack.dev.config.js"; // webpack 配置文件路径

    // Insert plugins.
    // expose target browser to webpack config
    process.env.EDGE_TARGET_BROWSER = browser;
    let webpack_config = require(webpack_path);
    webpack_config.plugins = webpack_config.plugins || [];
    const buildFlags = {
        pageTranslate: browser === "chrome",
        showFirefoxOptionsMenu: browser === "firefox",
        showFirefoxNoticeCopy: browser === "firefox",
        useFirefoxSelectionBehavior: browser === "firefox",
        useFirefoxTabMessaging: browser === "firefox",
        chromeDevHotReload: browser === "chrome" && environment === "development",
    };

    webpack_config.plugins.push(
        new webpack.DefinePlugin({
            BROWSER_ENV: JSON.stringify(browser),
            BUILD_ENV: JSON.stringify(environment),
            IS_CHROME: JSON.stringify(browser === "chrome"),
            IS_FIREFOX: JSON.stringify(browser === "firefox"),
            IS_SAFARI: JSON.stringify(browser === "safari"),
            FEATURE_FLAGS: JSON.stringify(buildFlags),
            "process.env.NODE_ENV": JSON.stringify(environment),
        })
    );

    return gulp
        .src("./src/**/*.js", { base: "src" })
        .pipe(webpack_stream(webpack_config, webpack))
        .pipe(gulp.dest(output_dir))
        .on("error", (error) => log(error));
}

/**
 * A private task to build js files in a child process in development mode with watch mode of webpack
 *
 * Hint: The watch mode of webpack in development mode will block the current gulp task. So the buildJS task need to to be run independently in command line in another process
 *
 * @param {Function} done execute done to inform gulp that the task is finished
 */
function buildJSDev(done) {
    let result = spawn("gulp", ["buildJS", "--browser", browser, "--color"]);
    result.stdout.on("data", (data) => {
        log(data);
    });
    result.stderr.on("data", (data) => {
        log(data);
    });
    done();
}

/**
 * A private task to merge manifest json files to one json file
 */
function manifest() {
    let output_dir = `./build/${browser}/`;
    let manifest_patch = `./src/manifest_${browser}.json`;
    if (browser === "safari") {
        // Safari uses mostly Chrome-compatible manifest with limited keys.
        manifest_patch = `./src/manifest_safari.json`;
    }
    return gulp
        .src("./src/manifest.json", { base: "src" })
        .pipe(merge_json(manifest_patch))
        .pipe(
            through.obj(function (file, enc, callback) {
                try {
                    if (browser === "safari") {
                        const manifestJson = JSON.parse(file.contents.toString(enc));
                        // Remove unsupported keys for Safari
                        if (manifestJson.background && manifestJson.background.type) {
                            delete manifestJson.background.type;
                        }
                        if (manifestJson.options_ui && manifestJson.options_ui.open_in_tab !== undefined) {
                            delete manifestJson.options_ui.open_in_tab;
                        }
                        if (Array.isArray(manifestJson.permissions)) {
                            manifestJson.permissions = manifestJson.permissions.filter(
                                (p) => p !== "notifications" && p !== "declarativeNetRequest"
                            );
                        }

                        // Convert MV3 background service_worker to MV2 background scripts for Safari
                        if (manifestJson.background && manifestJson.background.service_worker) {
                            const workerFile = manifestJson.background.service_worker;
                            manifestJson.background = { scripts: [workerFile] };
                        }

                        // Convert MV3 CSP object to MV2 string for Safari
                        if (manifestJson.content_security_policy) {
                            if (typeof manifestJson.content_security_policy === "object") {
                                manifestJson.content_security_policy =
                                    "script-src 'self'; object-src 'self'";
                            }
                        }

                        // Remove declarative_net_request rules for Safari
                        if (manifestJson.declarative_net_request) {
                            delete manifestJson.declarative_net_request;
                        }

                        file.contents = Buffer.from(JSON.stringify(manifestJson));
                    }
                } catch (e) {
                    log(e);
                }
                this.push(file);
                callback();
            })
        )
        .pipe(gulp.dest(output_dir));
}

/**
 * A private task to pack HTML files except HTML templates
 */
function html() {
    let output_dir = `./build/${browser}/`;
    return gulp.src(["./src/**/*.html"], { base: "src" }).pipe(gulp.dest(output_dir));
}

/**
 * A private task to convert styl to css files
 */
function styl() {
    let output_dir = `./build/${browser}/`;
    return gulp
        .src("./src/!(common)/**/*.styl", { base: "src" })
        .pipe(
            stylus({
                compress: true, // 需要压缩
            }).on("error", (error) => log(error))
        )
        .pipe(gulp.dest(output_dir));
}

/**
 * A private task to pack static files under "./static/"
 */
function packStatic() {
    let output_dir = `./build/${browser}/`;
    if (browser === "chrome") {
        // static JS files except google JS
        let staticJSFiles = gulp
            .src(["./static/**/!(element_main).js"], {
                base: "static",
                since: gulp.lastRun(packStatic),
            })
            .pipe(terser().on("error", (error) => log(error)))
            .pipe(gulp.dest(output_dir));

        // Optionally copy Google element_main.js without minifying (Chrome only)
        let googleJS = null;
        if (browser === "chrome") {
            googleJS = gulp
                .src("./static/google/element_main.js", {
                    base: "static",
                    allowEmpty: true,
                })
                .pipe(gulp.dest(output_dir));
        }

        // non-js static files
        let staticOtherFiles = gulp
            .src("./static/**/!(*.js)", { base: "static" })
            .pipe(gulp.dest(output_dir));

        // pdf.js viewer assets under ./web/**
        let webAssets = gulp.src(["./web/**"], { base: "." }).pipe(gulp.dest(output_dir));

        // pdf.js core files to build/ (sibling to web/), mirroring official layout
        let pdfjsCore = gulp
            .src([
                "../../node_modules/pdfjs-dist/build/pdf.mjs",
                "../../node_modules/pdfjs-dist/build/pdf.worker.mjs",
            ], { base: "../../node_modules/pdfjs-dist" })
            .pipe(gulp.dest(`${output_dir}build/`));

        const streams = [staticJSFiles, staticOtherFiles, webAssets, pdfjsCore];
        if (googleJS) streams.push(googleJS);
        return mergeStream(streams);
    }
    // static JS files except google JS; exclude entire google dir for non-Chrome
    let staticJSFiles = gulp
        .src(["./static/**/!(element_main).js", "!./static/google/**/*.js"], { base: "static" })
        .pipe(terser().on("error", (error) => log(error)))
        .pipe(gulp.dest(output_dir));

    // Do not copy any Google translate JS for non-Chrome builds
    let googleJS = null;

    // non-js static files; exclude entire google dir for non-Chrome
    let staticOtherFiles = gulp
        .src(["./static/**/!(*.js)", "!./static/google/**"], { base: "static" })
        .pipe(gulp.dest(output_dir));

    // pdf.js viewer assets under ./web/**
    let webAssets = gulp.src(["./web/**"], { base: "." }).pipe(gulp.dest(output_dir));

    // pdf.js core files to build/
    let pdfjsCore = gulp
        .src([
            "../../node_modules/pdfjs-dist/build/pdf.mjs",
            "../../node_modules/pdfjs-dist/build/pdf.worker.mjs",
        ], { base: "../../node_modules/pdfjs-dist" })
        .pipe(gulp.dest(`${output_dir}build/`));

    const streams = [staticJSFiles, staticOtherFiles, webAssets, pdfjsCore];
    if (googleJS) streams.push(googleJS);
    return mergeStream(streams);
}
/**
 * End private tasks' definition
 */

/**
 * Safari 전용: build 결과를 Xcode 프로젝트 리소스로 동기화 및 자동 리빌드
 */
function safariRsync(done) {
    if (browser !== "safari") return done();
    const args = [
        "-av",
        "--delete",
        "./build/safari/",
        "./safari-xcode/EdgeTranslate/EdgeTranslate Extension/Resources/",
    ];
    const proc = spawn("rsync", args, { stdio: "inherit" });
    proc.on("close", () => done());
}

function safariXcodeCleanResources(done) {
    if (browser !== "safari") return done();
    try {
        const pbxPath = path.resolve(
            __dirname,
            "./safari-xcode/EdgeTranslate/EdgeTranslate.xcodeproj/project.pbxproj"
        );
        if (!fs.existsSync(pbxPath)) return done();
        const original = fs.readFileSync(pbxPath, "utf8");
        let content = original;

        // Remove build file entries for 209.js and google resources
        content = content.replace(/\n\s*[^\n]*\/\* [^*]*209\\.js[^*]* \*\/ = \{[^}]*\};\n/g, "\n");
        content = content.replace(/\n\s*[^\n]*\/\* [^*]*google[^*]* \*\/ = \{[^}]*\};\n/g, "\n");

        // Remove file references for 209.js and Resources/google
        content = content.replace(/\n\s*[^\n]*\/\* 209\\.js \*\/ = \{[^}]*\};\n/g, "\n");
        content = content.replace(
            /\n\s*[^\n]*\/\* google \*\/ = \{[^}]*path = [^;]*google[^;]*;[^}]*\};\n/g,
            "\n"
        );

        // Remove list entries inside Resources build phase
        content = content.replace(/\s*[^\n]*\/\* [^*]*209\\.js in Resources \*\/,?\n/g, "");
        content = content.replace(/\s*[^\n]*\/\* [^*]*google[^*]* in Resources \*\/,?\n/g, "");

        if (content !== original) {
            const backup = pbxPath + ".bak";
            try {
                if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
            } catch {}
            fs.writeFileSync(pbxPath, content);
            log("Patched Xcode project: removed google/209.js resources from build");
        }
    } catch (e) {
        log(e);
    }
    done();
}

function safariXcodeBuild(done) {
    if (browser !== "safari") return done();
    const projectPath =
        "./safari-xcode/EdgeTranslate/EdgeTranslate.xcodeproj";
    const args = [
        "-project",
        projectPath,
        "-scheme",
        "EdgeTranslate",
        "-configuration",
        "Debug",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
    ];
    const proc = spawn("xcodebuild", args, { stdio: "inherit" });
    proc.on("close", () => done());
}

function safariWatchAndRebuild(done) {
    if (browser !== "safari") return done();
    let timer = null;
    const kick = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            gulp.series(safariRsync, safariXcodeCleanResources, safariXcodeBuild)((err) =>
                err && console.error(err)
            );
        }, 200);
    };
    gulp.watch("./build/safari/**", { ignoreInitial: false }).on("all", kick);
    done();
}

exports.safariRsync = safariRsync;
exports.devSafariXcode = gulp.series(
    setDevelopEnvironment,
    clean,
    gulp.parallel(eslintJS, buildJSDev, manifest, html, styl, packStatic),
    gulp.parallel(watcher, safariWatchAndRebuild)
);

/**
 * 一个简易gulp插件，接收一组json文件作为参数，将它们合并到gulp.src引用的基本json文件；
 * 在这里的作用是合并公共manifest和不同浏览器特有的manifest。
 */
function merge_json(...args) {
    let objs = [];
    for (let i in args) {
        objs.push(JSON.parse(fs.readFileSync(args[i])));
    }

    let stream = through.obj(function (file, enc, callback) {
        let obj = JSON.parse(file.contents.toString(enc));
        for (let i in objs) {
            obj = _.defaultsDeep(obj, objs[i]);
        }

        file.contents = Buffer.from(JSON.stringify(obj));
        this.push(file);
        callback();
    });

    return stream;
}

// 定义 log函数 ，便于输出task的执行情况
function log(d) {
    process.stdout.write(`${d}\n`);
}
