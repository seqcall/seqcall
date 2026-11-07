namespace Sample.Core.Domain;

/// <summary>Abstract base with abstract and virtual members.</summary>
public abstract class Shape
{
    public abstract double Area();

    public virtual string Describe() => $"{GetType().Name} with area {Area()}";
}

public class Circle : Shape
{
    private readonly double _radius;

    public Circle(double radius) => _radius = radius;

    public override double Area() => Math.PI * _radius * _radius;
}

public class Square(double side) : Shape
{
    public override double Area() => side * side;

    public override string Describe() => "Square: " + base.Describe();
}
