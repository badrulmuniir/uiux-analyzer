// Simple mobile menu toggle (demo)
document.addEventListener("DOMContentLoaded", function () {
  var toggle = document.getElementById("menuToggle");
  var nav = document.getElementById("mainNav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", function () {
    nav.classList.toggle("open");
  });
});
