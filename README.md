# SKYTHO — website

The website of **SKYTHO**, an autonomous search-and-rescue (SAR) drone built by students from Galați, Romania.

Live: **https://skytho.space** (Romanian) · **https://skytho.space/en/** (English)

The page tells the story of one rescue as a 3D film you scroll through: a hiker gets hurt in the mountains and presses SOS, the AI dispatcher answers in the app, the drone flies over the forest, finds the hiker from above and drops a first-aid kit. After the film, the drone is shown part by part, followed by the project, the team and a gallery of our test flights.

## How it works

- Plain HTML, CSS and JavaScript modules, no build step.
- 3D with [three.js](https://threejs.org/): the drone and the hiker are glTF models (`models/`) made in Blender from our CAD files, compressed with meshoptimizer.
- The camera, the drone and the hiker are driven by the scroll position (`js/main.js`); the landscape, trees and LIDAR scan are generated in `js/world.js`.
- Smooth scrolling with [Lenis](https://github.com/darkroomengineering/lenis).
- Without WebGL the page falls back to a normal article.

## Run it locally

Any static file server works, from this folder:

```
python -m http.server 8000
```

then open http://localhost:8000.

## Folders

| | |
|---|---|
| `index.html`, `en/index.html` | the page, in Romanian and English |
| `css/` | styles |
| `js/` | the scroll film, the 3D world, the drone |
| `models/` | drone and hiker (glTF) |
| `images/`, `media/` | photos, icons, test-flight videos |
| `vendor/` | three.js, its glTF loader, meshopt decoder, Lenis |

## Team

- **Otava Radu Ioan** — app, server, operator station, website
- **Frumuzache Dorin** — drone hardware and flight software
- Mentor: **Apostol Valeriu**, Centrul Județean de Excelență Galați

Contact: skytho.cex@gmail.com · Instagram [@skytho_drone](https://www.instagram.com/skytho_drone/)

## Third-party code

three.js, Lenis and the meshoptimizer decoder are included in `vendor/` under their MIT licences.
