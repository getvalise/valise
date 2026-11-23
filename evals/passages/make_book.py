"""Lay out Project Gutenberg's On Liberty as a book PDF with printed page numbers.

Two unnumbered front-matter pages come first, so the printed number differs
from the position in the file, as in a real book.
"""
import re, sys, html
from pathlib import Path
from reportlab.lib.pagesizes import A5
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak, Spacer

src, out = Path(sys.argv[1]), Path(sys.argv[2])
raw = src.read_text(encoding="utf-8")
body = raw[raw.index("CHAPTER I.", raw.index("CHAPTER V.") + 10):raw.index("*** END OF THE PROJECT GUTENBERG")]
styles = getSampleStyleSheet()
story = [Paragraph("On Liberty", styles["Title"]), Paragraph("John Stuart Mill", styles["Heading2"]), PageBreak(),
         Paragraph("Contents", styles["Heading2"])]
for n, name in enumerate(["Introductory", "Of the Liberty of Thought and Discussion", "Of Individuality", "Of the Limits to the Authority of Society over the Individual", "Applications"], 1):
    story.append(Paragraph(f"Chapter {n}. {name}", styles["Normal"]))
story.append(PageBreak())
for para in re.split(r"\n\s*\n", body):
    text = " ".join(para.split())
    if not text:
        continue
    style = styles["Heading2"] if text.startswith("CHAPTER") else styles["BodyText"]
    story.append(Paragraph(html.escape(text), style))

def numbered(canvas, doc):
    if doc.page > 2:
        canvas.setFont("Helvetica", 9)
        canvas.drawCentredString(A5[0] / 2, 20, str(doc.page - 2))

doc = SimpleDocTemplate(str(out), pagesize=A5, title="On Liberty", author="John Stuart Mill")
doc.build(story, onFirstPage=numbered, onLaterPages=numbered)
