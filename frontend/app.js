const GITHUB_USERNAME = "yuighjk";
const GITHUB_URL = `https://api.github.com/users/${GITHUB_USERNAME}`;
const API_BASE_URL = (window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");

const elements = {
  name: document.querySelector("#profile-name"),
  bio: document.querySelector("#profile-bio"),
  avatar: document.querySelector("#avatar"),
  githubLink: document.querySelector("#github-link"),
  repos: document.querySelector("#repo-count"),
  followers: document.querySelector("#follower-count"),
  following: document.querySelector("#following-count"),
  location: document.querySelector("#location"),
  form: document.querySelector("#note-form"),
  input: document.querySelector("#note-content"),
  status: document.querySelector("#form-status"),
  notes: document.querySelector("#notes"),
};

async function loadGitHubProfile() {
  try {
    const response = await fetch(GITHUB_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub API: ${response.status}`);
    const profile = await response.json();

    elements.name.textContent = profile.name || profile.login;
    elements.bio.textContent = profile.bio || "持续学习 Go、AWS 与云原生技术。";
    elements.avatar.src = profile.avatar_url;
    elements.avatar.alt = `${profile.login} 的 GitHub 头像`;
    elements.githubLink.href = profile.html_url;
    elements.repos.textContent = profile.public_repos ?? "--";
    elements.followers.textContent = profile.followers ?? "--";
    elements.following.textContent = profile.following ?? "--";
    elements.location.textContent = profile.location || "Earth";
  } catch (error) {
    console.error(error);
    elements.bio.textContent = "持续学习 Go、AWS 与云原生技术。";
  }
}

async function loadNotes() {
  if (!API_BASE_URL) return;
  try {
    const response = await fetch(`${API_BASE_URL}/api/notes`);
    if (!response.ok) throw new Error(`Notes API: ${response.status}`);
    renderNotes(await response.json());
  } catch (error) {
    console.error(error);
    elements.notes.replaceChildren(createMessage("后端尚未上线，留言将在 API 配置完成后显示。"));
  }
}

function renderNotes(notes) {
  elements.notes.replaceChildren();
  if (!notes.length) {
    elements.notes.append(createMessage("还没有留言，来写第一条吧。"));
    return;
  }
  notes.forEach((note) => {
    const article = document.createElement("article");
    article.className = "note";
    const content = document.createElement("p");
    content.textContent = note.content;
    const time = document.createElement("time");
    time.dateTime = note.createdAt;
    time.textContent = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(note.createdAt));
    article.append(content, time);
    elements.notes.append(article);
  });
}

function createMessage(text) {
  const message = document.createElement("p");
  message.className = "empty-state";
  message.textContent = text;
  return message;
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!API_BASE_URL) return;
  elements.status.textContent = "正在提交……";
  try {
    const response = await fetch(`${API_BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: elements.input.value.trim() }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `提交失败：${response.status}`);
    }
    elements.input.value = "";
    elements.status.textContent = "提交成功。";
    await loadNotes();
  } catch (error) {
    elements.status.textContent = error.message;
  }
});

document.querySelector("#year").textContent = new Date().getFullYear();
loadGitHubProfile();
loadNotes();
