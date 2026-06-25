document.querySelectorAll("[data-quiz]").forEach((quiz) => {
  quiz.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-choice]");
    if (!button) return;

    const question = button.closest("[data-answer]");
    const feedback = question.querySelector(".feedback");
    const answer = question.dataset.answer;

    question.querySelectorAll("button[data-choice]").forEach((candidate) => {
      candidate.classList.remove("correct", "incorrect");
    });

    if (button.dataset.choice === answer) {
      button.classList.add("correct");
      feedback.textContent =
        "正确。把这个职责归到这一层，后面的代码路径就清楚了。";
    } else {
      button.classList.add("incorrect");
      feedback.textContent = `再想一下。答案是：${answer}。`;
    }
  });
});
